use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    io::SeekFrom,
    os::unix::ffi::{OsStrExt, OsStringExt},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    process::Command,
    sync::RwLock,
};
use tokio_util::io::ReaderStream;
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use uuid::Uuid;

const SESSION_COOKIE: &str = "rfb_session";
const SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    password_hash: Arc<String>,
    sessions: Arc<DashMap<String, Session>>,
    login_attempts: Arc<DashMap<String, Vec<SystemTime>>>,
    media_jobs: Arc<DashMap<String, MediaJob>>,
    provenance: Arc<RwLock<HashMap<String, Vec<String>>>>,
}

struct Config {
    root: PathBuf,
    root_canonical: PathBuf,
    trash: PathBuf,
    cache: PathBuf,
    username: String,
    secure_cookies: bool,
    editor_max: u64,
    upload_max: u64,
    cache_max: u64,
    cache_age_days: u64,
}

#[derive(Clone)]
struct Session {
    csrf: String,
    expires: SystemTime,
}

#[derive(Debug, Serialize)]
struct Problem {
    code: &'static str,
    message: String,
}

#[derive(Debug)]
struct ApiError(StatusCode, &'static str, String);

impl ApiError {
    fn bad(code: &'static str, message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, code, message.into())
    }
    fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self(StatusCode::FORBIDDEN, code, message.into())
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self(StatusCode::NOT_FOUND, "not_found", message.into())
    }
    fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self(StatusCode::CONFLICT, code, message.into())
    }
    fn internal(error: impl std::fmt::Display) -> Self {
        error!(%error, "internal request failure");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "The operation failed".into(),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(Problem {
                code: self.1,
                message: self.2,
            }),
        )
            .into_response()
    }
}

impl From<std::io::Error> for ApiError {
    fn from(value: std::io::Error) -> Self {
        match value.kind() {
            std::io::ErrorKind::NotFound => ApiError::not_found("The item does not exist"),
            std::io::ErrorKind::PermissionDenied => {
                ApiError::forbidden("permission_denied", "Permission denied")
            }
            std::io::ErrorKind::AlreadyExists => {
                ApiError::conflict("already_exists", "The destination exists")
            }
            _ => ApiError::internal(value),
        }
    }
}

type ApiResult<T> = Result<T, ApiError>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let root = PathBuf::from(std::env::var("RFB_ROOT").unwrap_or_else(|_| "/fs-root".into()));
    fs::create_dir_all(&root)
        .await
        .expect("create filesystem root");
    let root_canonical = fs::canonicalize(&root)
        .await
        .expect("canonicalize filesystem root");
    let trash = root.join(".trash");
    let cache = root.join(".cache/remote-file-browser");
    fs::create_dir_all(trash.join("items"))
        .await
        .expect("create trash");
    fs::create_dir_all(cache.join("thumbnails"))
        .await
        .expect("create thumbnail cache");
    fs::create_dir_all(cache.join("hls"))
        .await
        .expect("create media cache");
    let provenance = load_provenance(&cache).await;

    let password = read_secret().await;
    assert!(
        password.chars().count() >= 12,
        "administrator password must contain at least 12 characters"
    );
    let salt = SaltString::encode_b64(&rand::random::<[u8; 16]>()).expect("valid password salt");
    let password_hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .unwrap()
        .to_string();

    let config = Config {
        root,
        root_canonical,
        trash,
        cache,
        username: env_string("RFB_ADMIN_USERNAME", "admin"),
        secure_cookies: env_bool("RFB_SECURE_COOKIES", true),
        editor_max: env_u64("RFB_EDITOR_MAX_BYTES", 5 * 1024 * 1024),
        upload_max: env_u64("RFB_UPLOAD_MAX_BYTES", 20 * 1024 * 1024 * 1024),
        cache_max: env_u64("RFB_CACHE_MAX_BYTES", 10 * 1024 * 1024 * 1024),
        cache_age_days: env_u64("RFB_CACHE_MAX_AGE_DAYS", 30),
    };
    let body_limit =
        usize::try_from(config.upload_max.min(usize::MAX as u64)).unwrap_or(usize::MAX);
    let state = AppState {
        config: Arc::new(config),
        password_hash: Arc::new(password_hash),
        sessions: Arc::new(DashMap::new()),
        login_attempts: Arc::new(DashMap::new()),
        media_jobs: Arc::new(DashMap::new()),
        provenance: Arc::new(RwLock::new(provenance)),
    };

    spawn_cache_cleanup(state.clone());

    let api = Router::new()
        .route("/auth/login", post(login))
        .route("/auth/session", get(session_info))
        .route("/auth/logout", post(logout))
        .route("/fs/entries", get(list_entries))
        .route("/fs/metadata", get(metadata))
        .route("/fs/provenance", get(get_provenance).put(set_provenance))
        .route("/fs/content", get(content))
        .route("/fs/items", post(create_item))
        .route("/fs/uploads", post(upload))
        .route("/fs/operations", post(operation))
        .route("/fs/trash", post(soft_delete))
        .route("/editor/document", get(read_document).put(write_document))
        .route("/trash", get(list_trash).delete(empty_trash))
        .route("/trash/{id}/restore", post(restore_trash))
        .route("/trash/{id}", delete(purge_trash))
        .route("/previews/thumbnail", get(thumbnail))
        .route("/media/file", get(media_file))
        .route("/media/hls", post(start_hls))
        .route("/media/jobs", get(list_media_jobs))
        .route("/media/hls/{key}/status", get(hls_status))
        .route("/media/hls/{key}/{file}", get(hls_file));

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/api/v1", api)
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    info!(address = %listener.local_addr().unwrap(), "remote file browser backend started");
    axum::serve(listener, app).await.unwrap();
}

async fn read_secret() -> String {
    if let Ok(path) = std::env::var("RFB_ADMIN_PASSWORD_FILE") {
        return fs::read_to_string(path)
            .await
            .expect("read administrator password secret")
            .trim_end()
            .to_string();
    }
    std::env::var("RFB_ADMIN_PASSWORD")
        .expect("RFB_ADMIN_PASSWORD_FILE or RFB_ADMIN_PASSWORD is required")
}

fn env_string(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}
fn env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    authenticated: bool,
    username: Option<String>,
    csrf_token: Option<String>,
}

async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(input): Json<LoginRequest>,
) -> ApiResult<(CookieJar, Json<SessionResponse>)> {
    let client = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .split(',')
        .next()
        .unwrap_or("unknown")
        .trim()
        .to_string();
    let now = SystemTime::now();
    {
        let mut attempts = state.login_attempts.entry(client.clone()).or_default();
        attempts.retain(|at| {
            now.duration_since(*at).unwrap_or_default() < Duration::from_secs(15 * 60)
        });
        if attempts.len() >= 5 {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many login attempts; try again later".into(),
            ));
        }
    }
    let parsed = PasswordHash::new(&state.password_hash).map_err(ApiError::internal)?;
    let valid = input.username == state.config.username
        && Argon2::default()
            .verify_password(input.password.as_bytes(), &parsed)
            .is_ok();
    if !valid {
        state.login_attempts.entry(client).or_default().push(now);
        tokio::time::sleep(Duration::from_millis(350)).await;
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Invalid username or password".into(),
        ));
    }
    let token = random_token();
    let csrf = random_token();
    state.sessions.insert(
        token.clone(),
        Session {
            csrf: csrf.clone(),
            expires: now + SESSION_TTL,
        },
    );
    let cookie = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .secure(state.config.secure_cookies)
        .same_site(SameSite::Strict)
        .max_age(time::Duration::hours(12))
        .build();
    Ok((
        jar.add(cookie),
        Json(SessionResponse {
            authenticated: true,
            username: Some(state.config.username.clone()),
            csrf_token: Some(csrf),
        }),
    ))
}

async fn session_info(State(state): State<AppState>, jar: CookieJar) -> Json<SessionResponse> {
    match require_session(&state, &jar) {
        Ok(session) => Json(SessionResponse {
            authenticated: true,
            username: Some(state.config.username.clone()),
            csrf_token: Some(session.csrf),
        }),
        Err(_) => Json(SessionResponse {
            authenticated: false,
            username: None,
            csrf_token: None,
        }),
    }
}

async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> ApiResult<(CookieJar, StatusCode)> {
    let _ = require_csrf(&state, &jar, &headers)?;
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        state.sessions.remove(cookie.value());
    }
    Ok((
        jar.remove(Cookie::build(SESSION_COOKIE).path("/").build()),
        StatusCode::NO_CONTENT,
    ))
}

fn require_session(state: &AppState, jar: &CookieJar) -> ApiResult<Session> {
    let token = jar
        .get(SESSION_COOKIE)
        .ok_or_else(|| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Login required".into(),
            )
        })?
        .value()
        .to_string();
    let mut session = state.sessions.get_mut(&token).ok_or_else(|| {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Session expired".into(),
        )
    })?;
    if session.expires < SystemTime::now() {
        drop(session);
        state.sessions.remove(&token);
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Session expired".into(),
        ));
    }
    session.expires = SystemTime::now() + SESSION_TTL;
    Ok(session.clone())
}

fn require_csrf(state: &AppState, jar: &CookieJar, headers: &HeaderMap) -> ApiResult<Session> {
    let session = require_session(state, jar)?;
    let supplied = headers.get("x-csrf-token").and_then(|h| h.to_str().ok());
    if supplied != Some(session.csrf.as_str()) {
        return Err(ApiError::forbidden(
            "csrf_failed",
            "Missing or invalid CSRF token",
        ));
    }
    Ok(session)
}

fn random_token() -> String {
    let bytes: [u8; 32] = rand::random();
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    parent_id: String,
    path: String,
    name: String,
    kind: String,
    size: u64,
    mode: u32,
    permissions: String,
    uid: u32,
    gid: u32,
    modified_at: Option<DateTime<Utc>>,
    accessed_at: Option<DateTime<Utc>>,
    created_at: Option<DateTime<Utc>>,
    mime: String,
    symlink_target: Option<String>,
    etag: String,
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    id: String,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
    #[serde(default)]
    hidden: bool,
    sort: Option<String>,
    direction: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryPage {
    entries: Vec<Entry>,
    total: usize,
    next_offset: Option<usize>,
}

async fn list_entries(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<EntryPage>> {
    require_session(&state, &jar)?;
    let directory = resolve_existing(&state.config, &query.id).await?;
    if !fs::metadata(&directory).await?.is_dir() {
        return Err(ApiError::bad(
            "not_directory",
            "The selected item is not a directory",
        ));
    }
    let mut reader = fs::read_dir(&directory).await?;
    let mut entries = Vec::new();
    while let Some(item) = reader.next_entry().await? {
        let name = item.file_name();
        if is_internal(&directory, &state.config, &name) {
            continue;
        }
        if !query.hidden && name.as_bytes().starts_with(b".") {
            continue;
        }
        entries.push(entry_from_path(&state.config, item.path()).await?);
    }
    let sort = query.sort.as_deref().unwrap_or("name");
    entries.sort_by(|a, b| {
        let dirs = (a.kind != "directory").cmp(&(b.kind != "directory"));
        if dirs != std::cmp::Ordering::Equal {
            return dirs;
        }
        match sort {
            "size" => a.size.cmp(&b.size),
            "modified" => a.modified_at.cmp(&b.modified_at),
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    if query.direction.as_deref() == Some("desc") {
        entries.reverse();
    }
    let total = entries.len();
    let limit = query.limit.unwrap_or(200).clamp(1, 1000);
    let page = entries
        .into_iter()
        .skip(query.offset)
        .take(limit)
        .collect::<Vec<_>>();
    let next_offset = (query.offset + page.len() < total).then_some(query.offset + page.len());
    Ok(Json(EntryPage {
        entries: page,
        total,
        next_offset,
    }))
}

#[derive(Deserialize)]
struct IdQuery {
    id: String,
}

async fn metadata(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<IdQuery>,
) -> ApiResult<Json<Entry>> {
    require_session(&state, &jar)?;
    let path = resolve_existing(&state.config, &query.id).await?;
    Ok(Json(entry_from_path(&state.config, path).await?))
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Provenance {
    urls: Vec<String>,
}

async fn load_provenance(cache: &Path) -> HashMap<String, Vec<String>> {
    match fs::read(cache.join("provenance.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            error!(%error, "could not parse provenance metadata");
            HashMap::new()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(error) => {
            error!(%error, "could not read provenance metadata");
            HashMap::new()
        }
    }
}

async fn persist_provenance(state: &AppState) -> ApiResult<()> {
    let bytes = {
        let records = state.provenance.read().await;
        serde_json::to_vec_pretty(&*records).map_err(ApiError::internal)?
    };
    let target = state.config.cache.join("provenance.json");
    let temporary = state.config.cache.join(".provenance.json.tmp");
    fs::write(&temporary, bytes).await?;
    fs::rename(temporary, target).await?;
    Ok(())
}

async fn get_provenance(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<IdQuery>,
) -> ApiResult<Json<Provenance>> {
    require_session(&state, &jar)?;
    let path = resolve_existing(&state.config, &query.id).await?;
    if !fs::symlink_metadata(path).await?.is_file() {
        return Err(ApiError::bad(
            "not_file",
            "Provenance can only be attached to files",
        ));
    }
    let records = state.provenance.read().await;
    Ok(Json(Provenance {
        urls: records.get(&query.id).cloned().unwrap_or_default(),
    }))
}

async fn set_provenance(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(query): Query<IdQuery>,
    Json(input): Json<Provenance>,
) -> ApiResult<Json<Provenance>> {
    require_csrf(&state, &jar, &headers)?;
    let path = resolve_existing(&state.config, &query.id).await?;
    if !fs::symlink_metadata(path).await?.is_file() {
        return Err(ApiError::bad(
            "not_file",
            "Provenance can only be attached to files",
        ));
    }
    if input.urls.len() > 50 {
        return Err(ApiError::bad(
            "too_many_urls",
            "A file can have at most 50 provenance URLs",
        ));
    }
    let mut urls = Vec::with_capacity(input.urls.len());
    for value in input.urls {
        let value = value.trim().to_string();
        let uri: http::Uri = value
            .parse()
            .map_err(|_| ApiError::bad("invalid_url", "Enter a valid HTTP or HTTPS URL"))?;
        if !matches!(uri.scheme_str(), Some("http" | "https"))
            || uri.authority().is_none()
            || value.len() > 2048
        {
            return Err(ApiError::bad(
                "invalid_url",
                "Enter a valid HTTP or HTTPS URL",
            ));
        }
        if !urls.contains(&value) {
            urls.push(value);
        }
    }
    {
        let mut records = state.provenance.write().await;
        if urls.is_empty() {
            records.remove(&query.id);
        } else {
            records.insert(query.id, urls.clone());
        }
    }
    persist_provenance(&state).await?;
    Ok(Json(Provenance { urls }))
}

async fn remap_provenance(
    state: &AppState,
    source: &Path,
    target: &Path,
    copy: bool,
) -> ApiResult<()> {
    let source_relative = source
        .strip_prefix(&state.config.root)
        .map_err(ApiError::internal)?;
    let target_relative = target
        .strip_prefix(&state.config.root)
        .map_err(ApiError::internal)?;
    let changes = {
        let records = state.provenance.read().await;
        records
            .iter()
            .filter_map(|(id, urls)| {
                let path = decode_path(id).ok()?;
                let suffix = path.strip_prefix(source_relative).ok()?;
                let new_path = if suffix.as_os_str().is_empty() {
                    target_relative.to_path_buf()
                } else {
                    target_relative.join(suffix)
                };
                Some((id.clone(), encode_path(new_path.as_os_str()), urls.clone()))
            })
            .collect::<Vec<_>>()
    };
    if changes.is_empty() {
        return Ok(());
    }
    {
        let mut records = state.provenance.write().await;
        for (old, new, urls) in changes {
            if !copy {
                records.remove(&old);
            }
            records.insert(new, urls);
        }
    }
    persist_provenance(state).await
}

async fn entry_from_path(config: &Config, path: PathBuf) -> ApiResult<Entry> {
    let meta = fs::symlink_metadata(&path).await?;
    let relative = path
        .strip_prefix(&config.root)
        .map_err(ApiError::internal)?;
    let parent = relative.parent().unwrap_or(Path::new(""));
    let kind = if meta.file_type().is_dir() {
        "directory"
    } else if meta.file_type().is_file() {
        "file"
    } else if meta.file_type().is_symlink() {
        "symlink"
    } else {
        "other"
    };
    let mode = meta.permissions().mode() & 0o7777;
    let mime = if kind == "directory" {
        "inode/directory".into()
    } else {
        mime_guess::from_path(&path)
            .first_or_octet_stream()
            .to_string()
    };
    let symlink_target = if meta.file_type().is_symlink() {
        fs::read_link(&path)
            .await
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };
    let etag = format!(
        "\"{:x}-{:x}-{:x}\"",
        meta.ino(),
        meta.len(),
        meta.mtime_nsec() ^ meta.mtime()
    );
    Ok(Entry {
        id: encode_path(relative.as_os_str()),
        parent_id: encode_path(parent.as_os_str()),
        path: if relative.as_os_str().is_empty() {
            "/fs-root".into()
        } else {
            format!("/fs-root/{}", relative.to_string_lossy())
        },
        name: path
            .file_name()
            .unwrap_or_else(|| OsStr::new("/"))
            .to_string_lossy()
            .into_owned(),
        kind: kind.into(),
        size: meta.len(),
        mode,
        permissions: permission_string(mode, kind),
        uid: meta.uid(),
        gid: meta.gid(),
        modified_at: meta.modified().ok().map(DateTime::<Utc>::from),
        accessed_at: meta.accessed().ok().map(DateTime::<Utc>::from),
        created_at: meta.created().ok().map(DateTime::<Utc>::from),
        mime,
        symlink_target,
        etag,
    })
}

fn permission_string(mode: u32, kind: &str) -> String {
    let mut out = String::with_capacity(10);
    out.push(match kind {
        "directory" => 'd',
        "symlink" => 'l',
        _ => '-',
    });
    for shift in [6, 3, 0] {
        out.push(if mode & (4 << shift) != 0 { 'r' } else { '-' });
        out.push(if mode & (2 << shift) != 0 { 'w' } else { '-' });
        out.push(if mode & (1 << shift) != 0 { 'x' } else { '-' });
    }
    out
}

fn encode_path(path: &OsStr) -> String {
    URL_SAFE_NO_PAD.encode(path.as_bytes())
}

fn decode_path(id: &str) -> ApiResult<PathBuf> {
    if id.is_empty() {
        return Ok(PathBuf::new());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|_| ApiError::bad("invalid_id", "Invalid path identifier"))?;
    let path = PathBuf::from(OsString::from_vec(bytes));
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(ApiError::bad(
            "invalid_path",
            "The path must remain below the filesystem root",
        ));
    }
    Ok(path)
}

async fn resolve_existing(config: &Config, id: &str) -> ApiResult<PathBuf> {
    let relative = decode_path(id)?;
    if relative == Path::new(".trash")
        || relative.starts_with(Path::new(".trash"))
        || relative.starts_with(Path::new(".cache/remote-file-browser"))
    {
        return Err(ApiError::forbidden(
            "reserved_path",
            "This path is managed internally",
        ));
    }
    let joined = config.root.join(relative);
    let metadata = fs::symlink_metadata(&joined).await?;
    let canonical = match fs::canonicalize(&joined).await {
        Ok(path) => path,
        Err(_) if metadata.file_type().is_symlink() => {
            fs::canonicalize(
                joined
                    .parent()
                    .ok_or_else(|| ApiError::bad("invalid_path", "Path has no parent"))?,
            )
            .await?
        }
        Err(error) => return Err(error.into()),
    };
    if !canonical.starts_with(&config.root_canonical) {
        return Err(ApiError::forbidden(
            "path_escape",
            "The path resolves outside the filesystem root",
        ));
    }
    Ok(joined)
}

async fn resolve_parent(config: &Config, id: &str) -> ApiResult<PathBuf> {
    let path = resolve_existing(config, id).await?;
    if !fs::metadata(&path).await?.is_dir() {
        return Err(ApiError::bad(
            "not_directory",
            "Destination is not a directory",
        ));
    }
    Ok(path)
}

fn is_internal(directory: &Path, config: &Config, name: &OsStr) -> bool {
    directory == config.root && name == OsStr::new(".trash")
        || directory == config.root.join(".cache") && name == OsStr::new("remote-file-browser")
}

async fn content(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(query): Query<IdQuery>,
) -> ApiResult<Response> {
    require_session(&state, &jar)?;
    let path = resolve_existing(&state.config, &query.id).await?;
    serve_file(path, &headers, false).await
}

async fn serve_file(path: PathBuf, headers: &HeaderMap, inline: bool) -> ApiResult<Response> {
    let meta = fs::metadata(&path).await?;
    if !meta.is_file() {
        return Err(ApiError::bad(
            "not_file",
            "Only regular files can be streamed",
        ));
    }
    let total = meta.len();
    if total == 0 {
        return Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .to_string(),
            )
            .header(header::CONTENT_LENGTH, "0")
            .body(Body::empty())
            .map_err(ApiError::internal);
    }
    let (start, end, status) = parse_range(headers, total)?;
    let mut file = fs::File::open(&path).await?;
    file.seek(SeekFrom::Start(start)).await?;
    let length = end.saturating_sub(start) + 1;
    let stream = ReaderStream::new(file.take(length));
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string())
        .header("x-content-type-options", "nosniff");
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    if !inline {
        response = response.header(header::CONTENT_DISPOSITION, "attachment");
    }
    response
        .body(Body::from_stream(stream))
        .map_err(ApiError::internal)
}

fn parse_range(headers: &HeaderMap, total: u64) -> ApiResult<(u64, u64, StatusCode)> {
    if total == 0 {
        return Ok((0, 0, StatusCode::OK));
    }
    let Some(raw) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) else {
        return Ok((0, total - 1, StatusCode::OK));
    };
    let raw = raw.strip_prefix("bytes=").ok_or_else(|| {
        ApiError(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "invalid_range",
            "Invalid Range header".into(),
        )
    })?;
    let (a, b) = raw
        .split_once('-')
        .ok_or_else(|| ApiError::bad("invalid_range", "Invalid Range header"))?;
    let start: u64 = a
        .parse()
        .map_err(|_| ApiError::bad("invalid_range", "Suffix ranges are not supported"))?;
    let end: u64 = if b.is_empty() {
        total - 1
    } else {
        b.parse()
            .map_err(|_| ApiError::bad("invalid_range", "Invalid Range header"))?
    };
    if start >= total || end < start {
        return Err(ApiError(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "invalid_range",
            "Range is outside the file".into(),
        ));
    }
    Ok((start, end.min(total - 1), StatusCode::PARTIAL_CONTENT))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRequest {
    parent_id: String,
    name: String,
    kind: String,
    #[serde(default)]
    replace: bool,
}

async fn create_item(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(input): Json<CreateRequest>,
) -> ApiResult<(StatusCode, Json<Entry>)> {
    require_csrf(&state, &jar, &headers)?;
    validate_name(&input.name)?;
    let parent = resolve_parent(&state.config, &input.parent_id).await?;
    let path = parent.join(&input.name);
    if fs::symlink_metadata(&path).await.is_ok() {
        if !input.replace {
            return Err(ApiError::conflict(
                "already_exists",
                "An item with that name already exists",
            ));
        }
        move_to_trash(&state.config, &path).await?;
    }
    match input.kind.as_str() {
        "directory" => fs::create_dir(&path).await?,
        "file" => {
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .await?;
        }
        _ => {
            return Err(ApiError::bad(
                "invalid_kind",
                "Kind must be file or directory",
            ));
        }
    }
    Ok((
        StatusCode::CREATED,
        Json(entry_from_path(&state.config, path).await?),
    ))
}

fn validate_name(name: &str) -> ApiResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(ApiError::bad("invalid_name", "Invalid filename"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct UploadQuery {
    id: String,
    #[serde(default)]
    replace: bool,
}

async fn upload(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> ApiResult<Json<Vec<Entry>>> {
    require_csrf(&state, &jar, &headers)?;
    let parent = resolve_parent(&state.config, &query.id).await?;
    let mut uploaded = Vec::new();
    while let Some(mut field) = multipart.next_field().await.map_err(ApiError::internal)? {
        let name = field
            .file_name()
            .ok_or_else(|| ApiError::bad("missing_filename", "Upload has no filename"))?
            .to_string();
        validate_name(&name)?;
        let target = parent.join(&name);
        if fs::symlink_metadata(&target).await.is_ok() {
            if !query.replace {
                return Err(ApiError::conflict(
                    "already_exists",
                    format!("{name} already exists"),
                ));
            }
            move_to_trash(&state.config, &target).await?;
        }
        let temporary = parent.join(format!(".rfb-upload-{}", Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        let mut written = 0u64;
        while let Some(chunk) = field.chunk().await.map_err(ApiError::internal)? {
            written += chunk.len() as u64;
            if written > state.config.upload_max {
                let _ = fs::remove_file(&temporary).await;
                return Err(ApiError(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "upload_too_large",
                    "Upload exceeds configured limit".into(),
                ));
            }
            file.write_all(&chunk).await?;
        }
        file.sync_all().await?;
        fs::rename(&temporary, &target).await?;
        uploaded.push(entry_from_path(&state.config, target).await?);
    }
    Ok(Json(uploaded))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationRequest {
    operation: String,
    sources: Vec<String>,
    destination_id: String,
    name: Option<String>,
    #[serde(default)]
    replace: bool,
    #[serde(default)]
    merge: bool,
}

async fn operation(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(input): Json<OperationRequest>,
) -> ApiResult<Json<Vec<Entry>>> {
    require_csrf(&state, &jar, &headers)?;
    if input.sources.is_empty() || input.sources.len() > 100 {
        return Err(ApiError::bad(
            "invalid_batch",
            "Choose between 1 and 100 items",
        ));
    }
    let destination = resolve_parent(&state.config, &input.destination_id).await?;
    let mut results = Vec::new();
    for (index, id) in input.sources.iter().enumerate() {
        let source = resolve_existing(&state.config, id).await?;
        if source == state.config.root {
            return Err(ApiError::forbidden(
                "root_operation",
                "The filesystem root cannot be moved or copied",
            ));
        }
        let name = if index == 0 {
            input
                .name
                .as_deref()
                .map(OsString::from)
                .unwrap_or_else(|| source.file_name().unwrap().to_os_string())
        } else {
            source.file_name().unwrap().to_os_string()
        };
        if let Some(text) = name.to_str() {
            validate_name(text)?;
        }
        let target = destination.join(name);
        if source.is_dir() && target.starts_with(&source) {
            return Err(ApiError::bad(
                "recursive_destination",
                "A directory cannot be copied or moved inside itself",
            ));
        }
        let target_meta = fs::symlink_metadata(&target).await.ok();
        let merge_directories = input.merge
            && input.operation == "move"
            && source.is_dir()
            && target_meta.as_ref().is_some_and(|meta| meta.is_dir());
        if target_meta.is_some() && !merge_directories {
            if !input.replace {
                let code = if input.operation == "move"
                    && source.is_dir()
                    && target_meta.as_ref().is_some_and(|meta| meta.is_dir())
                {
                    "folder_merge_conflict"
                } else {
                    "already_exists"
                };
                return Err(ApiError::conflict(
                    code,
                    format!(
                        "{} already exists",
                        target.file_name().unwrap().to_string_lossy()
                    ),
                ));
            }
            move_to_trash(&state.config, &target).await?;
        }
        match input.operation.as_str() {
            "move" | "rename" => {
                if merge_directories {
                    merge_directory_trees(&state, &source, &target).await?;
                } else if fs::rename(&source, &target).await.is_err() {
                    copy_recursively(&source, &target).await?;
                    remove_recursively(&source).await?;
                }
                if !merge_directories {
                    remap_provenance(&state, &source, &target, false).await?;
                }
            }
            "copy" => {
                copy_recursively(&source, &target).await?;
                remap_provenance(&state, &source, &target, true).await?;
            }
            _ => {
                return Err(ApiError::bad(
                    "invalid_operation",
                    "Operation must be copy, move, or rename",
                ));
            }
        }
        results.push(entry_from_path(&state.config, target).await?);
    }
    Ok(Json(results))
}

async fn merge_directory_trees(state: &AppState, source: &Path, target: &Path) -> ApiResult<()> {
    enum MergeTask {
        Merge(PathBuf, PathBuf),
        Remove(PathBuf),
    }
    let mut tasks = vec![MergeTask::Merge(source.to_path_buf(), target.to_path_buf())];
    while let Some(task) = tasks.pop() {
        match task {
            MergeTask::Remove(path) => fs::remove_dir(&path).await?,
            MergeTask::Merge(source_dir, target_dir) => {
                tasks.push(MergeTask::Remove(source_dir.clone()));
                let mut reader = fs::read_dir(&source_dir).await?;
                while let Some(item) = reader.next_entry().await? {
                    let source_item = item.path();
                    let target_item = target_dir.join(item.file_name());
                    match fs::symlink_metadata(&target_item).await {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            if fs::rename(&source_item, &target_item).await.is_err() {
                                copy_recursively(&source_item, &target_item).await?;
                                remove_recursively(&source_item).await?;
                            }
                            remap_provenance(state, &source_item, &target_item, false).await?;
                        }
                        Ok(target_meta) => {
                            let source_meta = fs::symlink_metadata(&source_item).await?;
                            if source_meta.is_dir() && target_meta.is_dir() {
                                tasks.push(MergeTask::Merge(source_item, target_item));
                            } else {
                                move_to_trash(&state.config, &target_item).await?;
                                if fs::rename(&source_item, &target_item).await.is_err() {
                                    copy_recursively(&source_item, &target_item).await?;
                                    remove_recursively(&source_item).await?;
                                }
                                remap_provenance(state, &source_item, &target_item, false).await?;
                            }
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
    }
    Ok(())
}

async fn copy_recursively(source: &Path, target: &Path) -> ApiResult<()> {
    let source = source.to_path_buf();
    let target = target.to_path_buf();
    tokio::task::spawn_blocking(move || copy_sync(&source, &target))
        .await
        .map_err(ApiError::internal)??;
    Ok(())
}

fn copy_sync(source: &Path, target: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(source)?;
    if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(source)?, target)?;
    } else if meta.is_dir() {
        std::fs::create_dir(target)?;
        std::fs::set_permissions(target, meta.permissions())?;
        for item in std::fs::read_dir(source)? {
            let item = item?;
            copy_sync(&item.path(), &target.join(item.file_name()))?;
        }
    } else if meta.is_file() {
        std::fs::copy(source, target)?;
        std::fs::set_permissions(target, meta.permissions())?;
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "special files cannot be copied",
        ));
    }
    Ok(())
}

async fn remove_recursively(path: &Path) -> ApiResult<()> {
    let meta = fs::symlink_metadata(path).await?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        fs::remove_dir_all(path).await?;
    } else {
        fs::remove_file(path).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct DeleteRequest {
    ids: Vec<String>,
}

async fn soft_delete(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(input): Json<DeleteRequest>,
) -> ApiResult<StatusCode> {
    require_csrf(&state, &jar, &headers)?;
    if input.ids.is_empty() || input.ids.len() > 100 {
        return Err(ApiError::bad(
            "invalid_batch",
            "Choose between 1 and 100 items",
        ));
    }
    for id in input.ids {
        let path = resolve_existing(&state.config, &id).await?;
        if path == state.config.root {
            return Err(ApiError::forbidden(
                "root_operation",
                "The root cannot be deleted",
            ));
        }
        move_to_trash(&state.config, &path).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashInfo {
    id: Uuid,
    original_id: String,
    original_name: String,
    deleted_at: DateTime<Utc>,
}

async fn move_to_trash(config: &Config, path: &Path) -> ApiResult<TrashInfo> {
    let relative = path
        .strip_prefix(&config.root)
        .map_err(ApiError::internal)?;
    let info = TrashInfo {
        id: Uuid::new_v4(),
        original_id: encode_path(relative.as_os_str()),
        original_name: path.file_name().unwrap().to_string_lossy().into_owned(),
        deleted_at: Utc::now(),
    };
    let item = config.trash.join("items").join(info.id.to_string());
    fs::create_dir(&item).await?;
    let payload = item.join("payload");
    if fs::rename(path, &payload).await.is_err() {
        copy_recursively(path, &payload).await?;
        remove_recursively(path).await?;
    }
    fs::write(
        item.join("info.json"),
        serde_json::to_vec_pretty(&info).map_err(ApiError::internal)?,
    )
    .await?;
    Ok(info)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashEntry {
    info: TrashInfo,
    kind: String,
    size: u64,
}

async fn list_trash(
    State(state): State<AppState>,
    jar: CookieJar,
) -> ApiResult<Json<Vec<TrashEntry>>> {
    require_session(&state, &jar)?;
    let mut reader = fs::read_dir(state.config.trash.join("items")).await?;
    let mut result = Vec::new();
    while let Some(item) = reader.next_entry().await? {
        let Ok(data) = fs::read(item.path().join("info.json")).await else {
            continue;
        };
        let Ok(info) = serde_json::from_slice::<TrashInfo>(&data) else {
            continue;
        };
        let meta = fs::symlink_metadata(item.path().join("payload")).await?;
        result.push(TrashEntry {
            info,
            kind: if meta.is_dir() {
                "directory".into()
            } else {
                "file".into()
            },
            size: meta.len(),
        });
    }
    result.sort_by_key(|entry| std::cmp::Reverse(entry.info.deleted_at));
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreRequest {
    destination_id: Option<String>,
    #[serde(default)]
    replace: bool,
}

async fn restore_trash(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    AxumPath(id): AxumPath<Uuid>,
    Json(input): Json<RestoreRequest>,
) -> ApiResult<Json<Entry>> {
    require_csrf(&state, &jar, &headers)?;
    let item = state.config.trash.join("items").join(id.to_string());
    let info: TrashInfo = serde_json::from_slice(&fs::read(item.join("info.json")).await?)
        .map_err(ApiError::internal)?;
    let target = if let Some(parent_id) = input.destination_id {
        resolve_parent(&state.config, &parent_id)
            .await?
            .join(&info.original_name)
    } else {
        state.config.root.join(decode_path(&info.original_id)?)
    };
    if let Some(parent) = target.parent()
        && fs::metadata(parent)
            .await
            .map(|m| !m.is_dir())
            .unwrap_or(true)
    {
        return Err(ApiError::conflict(
            "parent_missing",
            "The original parent no longer exists",
        ));
    }
    if fs::symlink_metadata(&target).await.is_ok() {
        if !input.replace {
            return Err(ApiError::conflict(
                "already_exists",
                "The restore destination exists",
            ));
        }
        move_to_trash(&state.config, &target).await?;
    }
    let payload = item.join("payload");
    if fs::rename(&payload, &target).await.is_err() {
        copy_recursively(&payload, &target).await?;
        remove_recursively(&payload).await?;
    }
    fs::remove_dir_all(item).await?;
    Ok(Json(entry_from_path(&state.config, target).await?))
}

async fn purge_trash(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    AxumPath(id): AxumPath<Uuid>,
) -> ApiResult<StatusCode> {
    require_csrf(&state, &jar, &headers)?;
    let item = state.config.trash.join("items").join(id.to_string());
    if fs::metadata(&item).await.is_err() {
        return Err(ApiError::not_found("Trash item not found"));
    }
    fs::remove_dir_all(item).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn empty_trash(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    require_csrf(&state, &jar, &headers)?;
    let items = state.config.trash.join("items");
    let mut reader = fs::read_dir(&items).await?;
    while let Some(item) = reader.next_entry().await? {
        fs::remove_dir_all(item.path()).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    id: String,
    content: String,
    etag: String,
    mime: String,
}

async fn read_document(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<IdQuery>,
) -> ApiResult<Json<Document>> {
    require_session(&state, &jar)?;
    let path = resolve_existing(&state.config, &query.id).await?;
    let meta = fs::metadata(&path).await?;
    if !meta.is_file() || meta.len() > state.config.editor_max {
        return Err(ApiError::bad(
            "not_editable",
            "The file is not editable or exceeds the editor size limit",
        ));
    }
    let bytes = fs::read(&path).await?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| ApiError::bad("not_utf8", "Only UTF-8 text files can be edited"))?;
    Ok(Json(Document {
        id: query.id,
        content,
        etag: blake3::hash(&bytes).to_hex().to_string(),
        mime: mime_guess::from_path(path)
            .first_or_text_plain()
            .to_string(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteDocument {
    id: String,
    content: String,
    expected_etag: String,
}

async fn write_document(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(input): Json<WriteDocument>,
) -> ApiResult<Json<Document>> {
    require_csrf(&state, &jar, &headers)?;
    if input.content.len() as u64 > state.config.editor_max {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "document_too_large",
            "Document exceeds editor limit".into(),
        ));
    }
    let path = resolve_existing(&state.config, &input.id).await?;
    let existing = fs::read(&path).await?;
    if blake3::hash(&existing).to_hex().as_str() != input.expected_etag {
        return Err(ApiError::conflict(
            "edit_conflict",
            "The file changed since it was opened",
        ));
    }
    let mode = fs::metadata(&path).await?.permissions().mode();
    let parent = path.parent().unwrap();
    let temporary = parent.join(format!(".rfb-edit-{}", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .await?;
    file.write_all(input.content.as_bytes()).await?;
    file.sync_all().await?;
    fs::set_permissions(&temporary, std::fs::Permissions::from_mode(mode)).await?;
    fs::rename(&temporary, &path).await?;
    let bytes = input.content.into_bytes();
    Ok(Json(Document {
        id: input.id,
        content: String::from_utf8_lossy(&bytes).into_owned(),
        etag: blake3::hash(&bytes).to_hex().to_string(),
        mime: mime_guess::from_path(path)
            .first_or_text_plain()
            .to_string(),
    }))
}

#[derive(Deserialize)]
struct PreviewQuery {
    id: String,
    size: Option<String>,
}

async fn thumbnail(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(query): Query<PreviewQuery>,
) -> ApiResult<Response> {
    require_session(&state, &jar)?;
    let source = resolve_existing(&state.config, &query.id).await?;
    let meta = fs::metadata(&source).await?;
    if !meta.is_file() {
        return Err(ApiError::bad(
            "not_previewable",
            "Only regular files can have thumbnails",
        ));
    }
    let dimension = match query.size.as_deref() {
        Some("small") => 64,
        Some("large") => 384,
        _ => 192,
    };
    let key = blake3::hash(
        format!(
            "{}:{}:{}:{dimension}",
            query.id,
            meta.len(),
            meta.modified()
                .ok()
                .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )
        .as_bytes(),
    )
    .to_hex()
    .to_string();
    let output = state
        .config
        .cache
        .join("thumbnails")
        .join(format!("{key}.webp"));
    if fs::metadata(&output).await.is_err() {
        let temporary = output.with_extension("tmp.webp");
        let status = Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
            ])
            .arg(&source)
            .args([
                "-frames:v",
                "1",
                "-vf",
                &format!(
                    "thumbnail,scale={dimension}:{dimension}:force_original_aspect_ratio=decrease"
                ),
                "-y",
            ])
            .arg(&temporary)
            .status()
            .await
            .map_err(ApiError::internal)?;
        if !status.success() {
            let _ = fs::remove_file(&temporary).await;
            return Err(ApiError::bad(
                "preview_failed",
                "FFmpeg could not generate a preview",
            ));
        }
        fs::rename(temporary, &output).await?;
    }
    serve_file(output, &headers, true).await
}

async fn media_file(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(query): Query<IdQuery>,
) -> ApiResult<Response> {
    require_session(&state, &jar)?;
    let path = resolve_existing(&state.config, &query.id).await?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    if mime.type_() != mime_guess::mime::IMAGE
        && mime.type_() != mime_guess::mime::VIDEO
        && mime.type_() != mime_guess::mime::AUDIO
    {
        return Err(ApiError::bad(
            "unsafe_inline_type",
            "This file type is available only as a download",
        ));
    }
    serve_file(path, &headers, true).await
}

#[derive(Deserialize)]
struct HlsRequest {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HlsResponse {
    key: String,
    status: String,
    playlist_url: String,
    playable: bool,
    mode: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaJob {
    key: String,
    file_name: String,
    status: String,
    playable: bool,
    mode: String,
    started_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConversionMode {
    Remux,
    Audio,
    Full,
}

impl ConversionMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Remux => "remux",
            Self::Audio => "audio",
            Self::Full => "full",
        }
    }
}

#[derive(Deserialize)]
struct ProbeOutput {
    streams: Vec<ProbeStream>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    pix_fmt: Option<String>,
}

fn conversion_mode(probe: &ProbeOutput) -> ConversionMode {
    let video = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"));
    let Some(video) = video else {
        return ConversionMode::Full;
    };
    let compatible_video = video.codec_name.as_deref() == Some("h264")
        && matches!(video.pix_fmt.as_deref(), Some("yuv420p") | Some("yuvj420p"));
    if !compatible_video {
        return ConversionMode::Full;
    }
    match probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"))
    {
        None => ConversionMode::Remux,
        Some(audio) if audio.codec_name.as_deref() == Some("aac") => ConversionMode::Remux,
        Some(_) => ConversionMode::Audio,
    }
}

async fn probe_conversion_mode(source: &Path) -> ConversionMode {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,pix_fmt",
            "-of",
            "json",
        ])
        .arg(source)
        .output()
        .await;
    match output {
        Ok(output) if output.status.success() => {
            serde_json::from_slice::<ProbeOutput>(&output.stdout)
                .map(|probe| conversion_mode(&probe))
                .unwrap_or(ConversionMode::Full)
        }
        _ => ConversionMode::Full,
    }
}

fn playlist_state(directory: &Path) -> (bool, bool) {
    let Ok(content) = std::fs::read_to_string(directory.join("index.m3u8")) else {
        return (false, false);
    };
    let segments = content
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>();
    let playable = !segments.is_empty()
        && segments.iter().all(|name| {
            Path::new(name).components().count() == 1 && directory.join(name).is_file()
        });
    (
        playable,
        playable && content.lines().any(|line| line == "#EXT-X-ENDLIST"),
    )
}

fn cached_mode(directory: &Path) -> String {
    std::fs::read_to_string(directory.join("mode"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| matches!(value.as_str(), "remux" | "audio" | "full"))
        .unwrap_or_else(|| "full".into())
}

async fn list_media_jobs(
    State(state): State<AppState>,
    jar: CookieJar,
) -> ApiResult<Json<Vec<MediaJob>>> {
    require_session(&state, &jar)?;
    let mut jobs = state
        .media_jobs
        .iter()
        .map(|job| job.value().clone())
        .collect::<Vec<_>>();
    jobs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    jobs.truncate(20);
    Ok(Json(jobs))
}

async fn start_hls(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(input): Json<HlsRequest>,
) -> ApiResult<(StatusCode, Json<HlsResponse>)> {
    require_csrf(&state, &jar, &headers)?;
    let source = resolve_existing(&state.config, &input.id).await?;
    if !fs::metadata(&source).await?.is_file() {
        return Err(ApiError::bad(
            "not_file",
            "Video source must be a regular file",
        ));
    }
    let source_meta = fs::metadata(&source).await?;
    let fingerprint = format!(
        "{}:{}:{:?}:ffmpeg-8.1.2-progressive-hls-v2",
        input.id,
        source_meta.len(),
        source_meta.modified().ok()
    );
    let key = blake3::hash(fingerprint.as_bytes()).to_hex().to_string();
    let directory = state.config.cache.join("hls").join(&key);
    let playlist = directory.join("index.m3u8");
    let file_name = source
        .file_name()
        .unwrap_or_else(|| OsStr::new("video"))
        .to_string_lossy()
        .into_owned();
    let (cached_playable, cached_ready) = playlist_state(&directory);
    if cached_ready {
        let mode = cached_mode(&directory);
        state.media_jobs.insert(
            key.clone(),
            MediaJob {
                key: key.clone(),
                file_name,
                status: "ready".into(),
                playable: true,
                mode: mode.clone(),
                started_at: Utc::now(),
            },
        );
        return Ok((
            StatusCode::OK,
            Json(HlsResponse {
                key: key.clone(),
                status: "ready".into(),
                playlist_url: format!("/api/v1/media/hls/{key}/index.m3u8"),
                playable: true,
                mode,
            }),
        ));
    }
    let should_start = state
        .media_jobs
        .get(&key)
        .map(|job| job.status != "working")
        .unwrap_or(true);
    if should_start {
        state.media_jobs.remove(&key);
        if fs::metadata(&directory).await.is_ok() {
            fs::remove_dir_all(&directory).await?;
        }
        fs::create_dir_all(&directory).await?;
        let mode = probe_conversion_mode(&source).await;
        fs::write(directory.join("mode"), mode.as_str()).await?;
        state.media_jobs.insert(
            key.clone(),
            MediaJob {
                key: key.clone(),
                file_name,
                status: "working".into(),
                playable: false,
                mode: mode.as_str().into(),
                started_at: Utc::now(),
            },
        );
        let jobs = state.media_jobs.clone();
        let job_key = key.clone();
        tokio::spawn(async move {
            let segment = directory.join("segment-%05d.ts");
            let mut command = Command::new("ffmpeg");
            command
                .args([
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-i",
                ])
                .arg(source)
                .args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]);
            match mode {
                ConversionMode::Remux => {
                    command.args(["-c", "copy"]);
                }
                ConversionMode::Audio => {
                    command.args(["-c:v", "copy", "-c:a", "aac"]);
                }
                ConversionMode::Full => {
                    command.args([
                        "-vf",
                        "scale='min(1920,iw)':-2",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-pix_fmt",
                        "yuv420p",
                        "-force_key_frames",
                        "expr:gte(t,n_forced*4)",
                        "-c:a",
                        "aac",
                    ]);
                }
            }
            command
                .args([
                    "-hls_time",
                    "4",
                    "-hls_playlist_type",
                    "event",
                    "-hls_flags",
                    "temp_file",
                    "-hls_segment_filename",
                ])
                .arg(segment)
                .arg(&playlist);
            let child = command.spawn();
            let status = match child {
                Ok(mut child) => loop {
                    match child.try_wait() {
                        Ok(Some(status)) => break Some(status),
                        Ok(None) => {
                            let (playable, _) = playlist_state(&directory);
                            if playable && let Some(mut job) = jobs.get_mut(&job_key) {
                                job.playable = true;
                            }
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                        Err(_) => break None,
                    }
                },
                Err(_) => None,
            };
            let (playable, ready) = playlist_state(&directory);
            if let Some(mut job) = jobs.get_mut(&job_key) {
                job.playable = playable;
                job.status = if status.map(|s| s.success()).unwrap_or(false) && ready {
                    "ready".into()
                } else {
                    "failed".into()
                };
            }
        });
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(HlsResponse {
            key: key.clone(),
            status: "working".into(),
            playlist_url: format!("/api/v1/media/hls/{key}/index.m3u8"),
            playable: cached_playable,
            mode: state
                .media_jobs
                .get(&key)
                .map(|job| job.mode.clone())
                .unwrap_or_else(|| "full".into()),
        }),
    ))
}

async fn hls_status(
    State(state): State<AppState>,
    jar: CookieJar,
    AxumPath(key): AxumPath<String>,
) -> ApiResult<Json<HlsResponse>> {
    require_session(&state, &jar)?;
    if !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::bad("invalid_key", "Invalid media key"));
    }
    let directory = state.config.cache.join("hls").join(&key);
    let (disk_playable, disk_ready) = playlist_state(&directory);
    let job = state
        .media_jobs
        .get(&key)
        .map(|value| value.value().clone());
    let status = if disk_ready {
        "ready".into()
    } else {
        job.as_ref()
            .map(|v| v.status.clone())
            .unwrap_or_else(|| "missing".into())
    };
    let playable = disk_playable || job.as_ref().map(|v| v.playable).unwrap_or(false);
    let mode = job
        .map(|v| v.mode)
        .unwrap_or_else(|| cached_mode(&directory));
    Ok(Json(HlsResponse {
        key: key.clone(),
        status,
        playlist_url: format!("/api/v1/media/hls/{key}/index.m3u8"),
        playable,
        mode,
    }))
}

async fn hls_file(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    AxumPath((key, file)): AxumPath<(String, String)>,
) -> ApiResult<Response> {
    require_session(&state, &jar)?;
    if !key.chars().all(|c| c.is_ascii_hexdigit())
        || !(file == "index.m3u8" || (file.starts_with("segment-") && file.ends_with(".ts")))
    {
        return Err(ApiError::bad("invalid_media_path", "Invalid media path"));
    }
    let mut response = serve_file(
        state.config.cache.join("hls").join(key).join(&file),
        &headers,
        true,
    )
    .await?;
    if file == "index.m3u8" {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    } else {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            "private, max-age=86400".parse().unwrap(),
        );
    }
    Ok(response)
}

fn spawn_cache_cleanup(state: AppState) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = cleanup_cache(&state).await {
                error!(?error, "cache cleanup failed");
            }
            tokio::time::sleep(Duration::from_secs(60 * 60)).await;
        }
    });
}

async fn cleanup_cache(state: &AppState) -> ApiResult<()> {
    let max_age = Duration::from_secs(state.config.cache_age_days * 24 * 60 * 60);
    let cache = state.config.cache.clone();
    let max_bytes = state.config.cache_max;
    let active = state
        .media_jobs
        .iter()
        .filter(|job| job.status == "working")
        .map(|job| job.key.clone())
        .collect::<std::collections::HashSet<_>>();
    tokio::task::spawn_blocking(move || {
        let mut units = Vec::<(PathBuf, u64, SystemTime, bool)>::new();
        fn directory_stats(path: &Path) -> (u64, SystemTime) {
            let mut size = 0;
            let mut access = SystemTime::UNIX_EPOCH;
            if let Ok(read) = std::fs::read_dir(path) {
                for item in read.flatten() {
                    if let Ok(meta) = item.metadata() {
                        if meta.is_dir() {
                            let (child_size, child_access) = directory_stats(&item.path());
                            size += child_size;
                            access = access.max(child_access);
                        } else {
                            size += meta.len();
                            access = access.max(meta.accessed().unwrap_or(SystemTime::UNIX_EPOCH));
                        }
                    }
                }
            }
            (size, access)
        }
        if let Ok(read) = std::fs::read_dir(cache.join("thumbnails")) {
            for item in read.flatten() {
                if let Ok(meta) = item.metadata()
                    && meta.is_file()
                {
                    units.push((
                        item.path(),
                        meta.len(),
                        meta.accessed().unwrap_or(SystemTime::UNIX_EPOCH),
                        false,
                    ));
                }
            }
        }
        if let Ok(read) = std::fs::read_dir(cache.join("hls")) {
            for item in read.flatten() {
                if item.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                    && !active.contains(&item.file_name().to_string_lossy().into_owned())
                {
                    let (size, access) = directory_stats(&item.path());
                    units.push((item.path(), size, access, true));
                }
            }
        }
        let now = SystemTime::now();
        for (path, _, access, directory) in &units {
            if now.duration_since(*access).unwrap_or_default() > max_age {
                if *directory {
                    let _ = std::fs::remove_dir_all(path);
                } else {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        units.retain(|(path, _, _, _)| path.exists());
        let mut total: u64 = units.iter().map(|(_, size, _, _)| *size).sum();
        units.sort_by_key(|(_, _, access, _)| *access);
        for (path, size, _, directory) in units {
            if total <= max_bytes.saturating_mul(9) / 10 {
                break;
            }
            let removed = if directory {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
            if removed.is_ok() {
                total = total.saturating_sub(size);
            }
        }
        std::io::Result::Ok(())
    })
    .await
    .map_err(ApiError::internal)??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn probe(video: (&str, &str), audio: Option<&str>) -> ProbeOutput {
        let mut streams = vec![ProbeStream {
            codec_type: Some("video".into()),
            codec_name: Some(video.0.into()),
            pix_fmt: Some(video.1.into()),
        }];
        if let Some(codec) = audio {
            streams.push(ProbeStream {
                codec_type: Some("audio".into()),
                codec_name: Some(codec.into()),
                pix_fmt: None,
            });
        }
        ProbeOutput { streams }
    }
    #[test]
    fn path_ids_round_trip_non_utf8() {
        let raw = OsStr::from_bytes(b"folder/\xff-name");
        assert_eq!(
            decode_path(&encode_path(raw))
                .unwrap()
                .as_os_str()
                .as_bytes(),
            raw.as_bytes()
        );
    }
    #[test]
    fn traversal_is_rejected() {
        assert!(decode_path(&URL_SAFE_NO_PAD.encode(b"../etc")).is_err());
    }
    #[test]
    fn permissions_are_symbolic() {
        assert_eq!(permission_string(0o754, "file"), "-rwxr-xr--");
    }
    #[test]
    fn compatible_h264_is_remuxed() {
        assert_eq!(
            conversion_mode(&probe(("h264", "yuv420p"), Some("aac"))),
            ConversionMode::Remux
        );
        assert_eq!(
            conversion_mode(&probe(("h264", "yuv420p"), None)),
            ConversionMode::Remux
        );
    }
    #[test]
    fn compatible_video_with_other_audio_only_converts_audio() {
        assert_eq!(
            conversion_mode(&probe(("h264", "yuv420p"), Some("dts"))),
            ConversionMode::Audio
        );
    }
    #[test]
    fn incompatible_video_is_fully_converted() {
        assert_eq!(
            conversion_mode(&probe(("hevc", "yuv420p"), Some("aac"))),
            ConversionMode::Full
        );
        assert_eq!(
            conversion_mode(&probe(("h264", "yuv420p10le"), Some("aac"))),
            ConversionMode::Full
        );
    }
    #[test]
    fn playlist_requires_segments_and_endlist_to_be_ready() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("segment-00000.ts"), b"segment").unwrap();
        std::fs::write(
            directory.path().join("index.m3u8"),
            "#EXTM3U\n#EXTINF:4,\nsegment-00000.ts\n",
        )
        .unwrap();
        assert_eq!(playlist_state(directory.path()), (true, false));
        std::fs::write(
            directory.path().join("index.m3u8"),
            "#EXTM3U\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n",
        )
        .unwrap();
        assert_eq!(playlist_state(directory.path()), (true, true));
    }
}
