use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Write},
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::{Component, Path, PathBuf},
};

use bzip2::read::BzDecoder;
use flate2::read::GzDecoder;
use xz2::read::XzDecoder;
use zip::ZipArchive;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArchiveFormat {
    Zip,
    Tar,
    TarGz,
    TarBz2,
    TarXz,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ExtractError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Unsafe(String),
}

const SUFFIXES: &[(&[u8], ArchiveFormat)] = &[
    (b".tar.bz2", ArchiveFormat::TarBz2),
    (b".tar.gz", ArchiveFormat::TarGz),
    (b".tar.xz", ArchiveFormat::TarXz),
    (b".tbz2", ArchiveFormat::TarBz2),
    (b".tgz", ArchiveFormat::TarGz),
    (b".txz", ArchiveFormat::TarXz),
    (b".tar", ArchiveFormat::Tar),
    (b".zip", ArchiveFormat::Zip),
];

pub(crate) fn classify(name: &OsStr) -> Option<(ArchiveFormat, OsString)> {
    let bytes = name.as_bytes();
    for (suffix, format) in SUFFIXES {
        if bytes.len() >= suffix.len()
            && bytes[bytes.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
        {
            let stem = &bytes[..bytes.len() - suffix.len()];
            let destination = if stem.is_empty() || stem == b"." || stem == b".." {
                OsString::from("archive")
            } else {
                OsString::from(OsStr::from_bytes(stem))
            };
            return Some((*format, destination));
        }
    }
    None
}

pub(crate) fn extract(
    source: &Path,
    destination: &Path,
    format: ArchiveFormat,
) -> Result<(), ExtractError> {
    match format {
        ArchiveFormat::Zip => extract_zip(source, destination),
        ArchiveFormat::Tar => extract_tar(BufReader::new(File::open(source)?), destination),
        ArchiveFormat::TarGz => extract_tar(
            GzDecoder::new(BufReader::new(File::open(source)?)),
            destination,
        ),
        ArchiveFormat::TarBz2 => extract_tar(
            BzDecoder::new(BufReader::new(File::open(source)?)),
            destination,
        ),
        ArchiveFormat::TarXz => extract_tar(
            XzDecoder::new(BufReader::new(File::open(source)?)),
            destination,
        ),
    }
}

fn extract_zip(source: &Path, destination: &Path) -> Result<(), ExtractError> {
    let file = File::open(source)?;
    let mut archive = ZipArchive::new(file).map_err(invalid_zip)?;
    let mut directory_modes = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(invalid_zip)?;
        if entry.encrypted() {
            return Err(ExtractError::Invalid(format!(
                "Encrypted ZIP entries are not supported: {}",
                entry.name()
            )));
        }
        let raw_path = entry.enclosed_name().ok_or_else(|| {
            ExtractError::Unsafe(format!(
                "Archive entry escapes the destination: {}",
                entry.name()
            ))
        })?;
        let relative = normalized_relative(&raw_path)?;
        if relative.as_os_str().is_empty() {
            if entry.is_dir() {
                continue;
            }
            return Err(ExtractError::Unsafe(
                "Archive contains a file with an empty path".into(),
            ));
        }

        let mode = entry
            .unix_mode()
            .unwrap_or(if entry.is_dir() { 0o755 } else { 0o644 });
        let file_type = mode & 0o170000;
        if file_type != 0 && file_type != 0o040000 && file_type != 0o100000 {
            return Err(ExtractError::Unsafe(format!(
                "Archive contains an unsupported link or special entry: {}",
                relative.display()
            )));
        }

        let output = destination.join(&relative);
        if entry.is_dir() || file_type == 0o040000 {
            fs::create_dir_all(&output)?;
            directory_modes.push((output, mode & 0o777));
            continue;
        }
        if !entry.is_file() && file_type != 0 && file_type != 0o100000 {
            return Err(ExtractError::Unsafe(format!(
                "Archive contains an unsupported entry: {}",
                relative.display()
            )));
        }
        write_file(&mut entry, &output, mode & 0o777)?;
    }

    apply_directory_modes(directory_modes)?;
    Ok(())
}

fn extract_tar<R: Read>(reader: R, destination: &Path) -> Result<(), ExtractError> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|error| ExtractError::Invalid(format!("Invalid tar archive: {error}")))?;
    let mut directory_modes = Vec::new();

    for entry in entries {
        let mut entry = entry
            .map_err(|error| ExtractError::Invalid(format!("Invalid tar archive: {error}")))?;
        let raw_path = entry
            .path()
            .map_err(|error| ExtractError::Invalid(format!("Invalid tar path: {error}")))?;
        let relative = normalized_relative(&raw_path)?;
        let entry_type = entry.header().entry_type();
        if relative.as_os_str().is_empty() {
            if entry_type.is_dir() {
                continue;
            }
            return Err(ExtractError::Unsafe(
                "Archive contains a file with an empty path".into(),
            ));
        }
        let mode = entry
            .header()
            .mode()
            .unwrap_or(if entry_type.is_dir() { 0o755 } else { 0o644 })
            & 0o777;
        let output = destination.join(&relative);

        if entry_type.is_dir() {
            fs::create_dir_all(&output)?;
            directory_modes.push((output, mode));
        } else if entry_type.is_file() {
            write_file(&mut entry, &output, mode)?;
        } else {
            return Err(ExtractError::Unsafe(format!(
                "Archive contains an unsupported link or special entry: {}",
                relative.display()
            )));
        }
    }

    apply_directory_modes(directory_modes)?;
    Ok(())
}

fn normalized_relative(path: &Path) -> Result<PathBuf, ExtractError> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => normalized.push(name),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ExtractError::Unsafe(format!(
                    "Archive entry escapes the destination: {}",
                    path.display()
                )));
            }
        }
    }
    Ok(normalized)
}

fn write_file(reader: &mut impl Read, output: &Path, mode: u32) -> Result<(), ExtractError> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(output)?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| ExtractError::Invalid(format!("Archive data is corrupt: {error}")))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])?;
    }
    file.set_permissions(fs::Permissions::from_mode(mode))?;
    Ok(())
}

fn apply_directory_modes(mut directories: Vec<(PathBuf, u32)>) -> Result<(), ExtractError> {
    directories.sort_by_key(|(path, _)| std::cmp::Reverse(path.components().count()));
    for (path, mode) in directories {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

fn invalid_zip(error: zip::result::ZipError) -> ExtractError {
    ExtractError::Invalid(format!("Invalid ZIP archive: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bzip2::{Compression as BzipCompression, write::BzEncoder};
    use flate2::{Compression as GzipCompression, write::GzEncoder};
    use std::io::Write;
    use xz2::write::XzEncoder;
    use zip::write::SimpleFileOptions;

    #[test]
    fn classifies_supported_suffixes_and_removes_the_complete_suffix() {
        for (name, expected, format) in [
            ("photos.zip", "photos", ArchiveFormat::Zip),
            ("bundle.TAR", "bundle", ArchiveFormat::Tar),
            ("source.tar.gz", "source", ArchiveFormat::TarGz),
            ("source.tgz", "source", ArchiveFormat::TarGz),
            ("source.tar.bz2", "source", ArchiveFormat::TarBz2),
            ("source.tbz2", "source", ArchiveFormat::TarBz2),
            ("source.tar.xz", "source", ArchiveFormat::TarXz),
            ("source.txz", "source", ArchiveFormat::TarXz),
        ] {
            let (actual_format, destination) = classify(OsStr::new(name)).unwrap();
            assert_eq!(actual_format, format);
            assert_eq!(destination, expected);
        }
        assert!(classify(OsStr::new("notes.txt")).is_none());
        assert_eq!(classify(OsStr::new(".zip")).unwrap().1, "archive");
    }

    #[test]
    fn zip_extraction_writes_nested_files_and_preserves_basic_modes() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("sample.zip");
        let file = File::create(&source).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        writer
            .add_directory(
                "nested/",
                SimpleFileOptions::default().unix_permissions(0o750),
            )
            .unwrap();
        writer
            .start_file(
                "nested/run.sh",
                SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        writer.write_all(b"#!/bin/sh\n").unwrap();
        writer.finish().unwrap();

        let destination = root.path().join("output");
        fs::create_dir(&destination).unwrap();
        extract(&source, &destination, ArchiveFormat::Zip).unwrap();

        assert_eq!(
            fs::read(destination.join("nested/run.sh")).unwrap(),
            b"#!/bin/sh\n"
        );
        assert_eq!(
            fs::metadata(destination.join("nested/run.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }

    #[test]
    fn zip_extraction_rejects_parent_traversal() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("unsafe.zip");
        let file = File::create(&source).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file("../escape.txt", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"escape").unwrap();
        writer.finish().unwrap();

        let destination = root.path().join("output");
        fs::create_dir(&destination).unwrap();
        assert!(matches!(
            extract(&source, &destination, ArchiveFormat::Zip),
            Err(ExtractError::Unsafe(_))
        ));
        assert!(!root.path().join("escape.txt").exists());
    }

    #[test]
    fn extracts_tar_and_supported_compressed_tarballs() {
        let tar = sample_tar();
        for (format, bytes) in [
            (ArchiveFormat::Tar, tar.clone()),
            (ArchiveFormat::TarGz, gzip(&tar)),
            (ArchiveFormat::TarBz2, bzip2(&tar)),
            (ArchiveFormat::TarXz, xz(&tar)),
        ] {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("archive");
            let destination = root.path().join("output");
            fs::write(&source, bytes).unwrap();
            fs::create_dir(&destination).unwrap();

            extract(&source, &destination, format).unwrap();

            assert_eq!(
                fs::read(destination.join("nested/file.txt")).unwrap(),
                b"archive contents"
            );
        }
    }

    #[test]
    fn tar_extraction_rejects_links() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("unsafe.tar");
        let destination = root.path().join("output");
        let mut builder = tar::Builder::new(File::create(&source).unwrap());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_cksum();
        header.set_link_name("../../escape").unwrap();
        builder
            .append_data(&mut header, "link", io::empty())
            .unwrap();
        builder.finish().unwrap();
        fs::create_dir(&destination).unwrap();

        assert!(matches!(
            extract(&source, &destination, ArchiveFormat::Tar),
            Err(ExtractError::Unsafe(_))
        ));
    }

    fn sample_tar() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let contents = b"archive contents";
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(contents.len() as u64);
        header.set_mode(0o640);
        header.set_cksum();
        builder
            .append_data(&mut header, "nested/file.txt", &contents[..])
            .unwrap();
        builder.into_inner().unwrap()
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut writer = GzEncoder::new(Vec::new(), GzipCompression::default());
        writer.write_all(bytes).unwrap();
        writer.finish().unwrap()
    }

    fn bzip2(bytes: &[u8]) -> Vec<u8> {
        let mut writer = BzEncoder::new(Vec::new(), BzipCompression::default());
        writer.write_all(bytes).unwrap();
        writer.finish().unwrap()
    }

    fn xz(bytes: &[u8]) -> Vec<u8> {
        let mut writer = XzEncoder::new(Vec::new(), 6);
        writer.write_all(bytes).unwrap();
        writer.finish().unwrap()
    }
}
