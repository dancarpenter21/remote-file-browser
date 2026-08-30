CREATE TABLE provenance_subjects (
    id uuid PRIMARY KEY,
    active_id text UNIQUE,
    active_path bytea UNIQUE,
    trash_id uuid,
    trash_suffix bytea,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((active_id IS NOT NULL AND active_path IS NOT NULL AND trash_id IS NULL AND trash_suffix IS NULL)
        OR (active_id IS NULL AND active_path IS NULL AND trash_id IS NOT NULL AND trash_suffix IS NOT NULL))
);

CREATE INDEX provenance_subjects_trash_idx ON provenance_subjects (trash_id);

CREATE TABLE provenance_urls (
    subject_id uuid NOT NULL REFERENCES provenance_subjects(id) ON DELETE CASCADE,
    ordinal smallint NOT NULL CHECK (ordinal >= 0 AND ordinal < 50),
    url text NOT NULL CHECK (length(url) <= 2048),
    PRIMARY KEY (subject_id, ordinal),
    UNIQUE (subject_id, url)
);

