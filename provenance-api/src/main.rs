use std::{collections::HashMap, net::SocketAddr};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgPoolOptions};
use tracing::info;
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
}

#[derive(Debug)]
struct ApiError(StatusCode, &'static str, String);

impl ApiError {
    fn bad(code: &'static str, message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, code, message.into())
    }
    fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self(StatusCode::CONFLICT, code, message.into())
    }
    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "provenance API failure");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "The provenance service failed".into(),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(serde_json::json!({"code": self.1, "message": self.2})),
        )
            .into_response()
    }
}
type ApiResult<T> = Result<T, ApiError>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lookup {
    ids: Vec<String>,
}
#[derive(Serialize)]
struct Records {
    records: HashMap<String, Vec<String>>,
}
#[derive(Deserialize)]
struct RecordInput {
    id: String,
    urls: Vec<String>,
}
#[derive(Deserialize)]
struct AppendInput {
    id: String,
    url: String,
}
#[derive(Serialize)]
struct RecordOutput {
    id: String,
    urls: Vec<String>,
}
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Lifecycle {
    Move {
        source_id: String,
        target_id: String,
    },
    Copy {
        source_id: String,
        target_id: String,
    },
    Trash {
        source_id: String,
        trash_id: Uuid,
    },
    Restore {
        trash_id: Uuid,
        target_id: String,
    },
    Purge {
        trash_id: Uuid,
    },
}
#[derive(Serialize)]
struct Changes {
    changes: Vec<RecordOutput>,
}
#[derive(Deserialize)]
struct ImportInput {
    records: HashMap<String, Vec<String>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    imported: usize,
    skipped: bool,
}
#[derive(Serialize)]
struct Status {
    empty: bool,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let password = match std::env::var("PROVENANCE_DB_PASSWORD") {
        Ok(password) => password,
        Err(_) => {
            let password_file = std::env::var("PROVENANCE_DB_PASSWORD_FILE")
                .unwrap_or_else(|_| "/run/secrets/provenance_db_password".into());
            tokio::fs::read_to_string(password_file)
                .await
                .expect("read provenance database password")
        }
    };
    let host = std::env::var("PROVENANCE_DB_HOST").unwrap_or_else(|_| "provenance-db".into());
    let user = std::env::var("PROVENANCE_DB_USER").unwrap_or_else(|_| "rfb_provenance".into());
    let database = std::env::var("PROVENANCE_DB_NAME").unwrap_or_else(|_| "rfb_provenance".into());
    let port = std::env::var("PROVENANCE_DB_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5432);
    let options = sqlx::postgres::PgConnectOptions::new()
        .host(&host)
        .port(port)
        .username(&user)
        .password(password.trim())
        .database(&database);
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect_with(options)
        .await
        .expect("connect provenance database");
    sqlx::migrate!()
        .run(&pool)
        .await
        .expect("run provenance migrations");
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/internal/v1/status", get(status))
        .route("/internal/v1/provenance/lookup", post(lookup))
        .route("/internal/v1/provenance", put(set_record))
        .route("/internal/v1/provenance/append", post(append_record))
        .route("/internal/v1/provenance/lifecycle", post(lifecycle))
        .route("/internal/v1/provenance/import", post(import_records))
        .with_state(AppState { pool });
    let address: SocketAddr = "0.0.0.0:8090".parse().unwrap();
    info!(%address, "provenance API listening");
    axum::serve(tokio::net::TcpListener::bind(address).await.unwrap(), app)
        .await
        .unwrap();
}

async fn health(State(state): State<AppState>) -> ApiResult<StatusCode> {
    sqlx::query("SELECT 1")
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn status(State(state): State<AppState>) -> ApiResult<Json<Status>> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM provenance_subjects")
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(Status { empty: count == 0 }))
}
fn decode_id(id: &str) -> ApiResult<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|_| ApiError::bad("invalid_id", "Invalid path identifier"))
}
fn encode_id(path: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(path)
}
fn valid_urls(input: Vec<String>) -> ApiResult<Vec<String>> {
    if input.len() > 50 {
        return Err(ApiError::bad(
            "too_many_urls",
            "A file can have at most 50 provenance URLs",
        ));
    }
    let mut result = Vec::new();
    for raw in input {
        let value = raw.trim().to_string();
        let parsed = Url::parse(&value)
            .map_err(|_| ApiError::bad("invalid_url", "Enter a valid HTTP or HTTPS URL"))?;
        if !matches!(parsed.scheme(), "http" | "https") || value.len() > 2048 {
            return Err(ApiError::bad(
                "invalid_url",
                "Enter a valid HTTP or HTTPS URL",
            ));
        }
        if !result.contains(&value) {
            result.push(value);
        }
    }
    Ok(result)
}
async fn urls_for(pool: &PgPool, subject: Uuid) -> ApiResult<Vec<String>> {
    sqlx::query_scalar("SELECT url FROM provenance_urls WHERE subject_id=$1 ORDER BY ordinal")
        .bind(subject)
        .fetch_all(pool)
        .await
        .map_err(ApiError::internal)
}
async fn lookup(
    State(state): State<AppState>,
    Json(input): Json<Lookup>,
) -> ApiResult<Json<Records>> {
    if input.ids.len() > 1000 {
        return Err(ApiError::bad(
            "invalid_batch",
            "At most 1000 identifiers may be queried",
        ));
    }
    let rows =
        sqlx::query("SELECT id, active_id FROM provenance_subjects WHERE active_id = ANY($1)")
            .bind(&input.ids)
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    let mut records = HashMap::new();
    for row in rows {
        let subject: Uuid = row.get("id");
        let id: String = row.get("active_id");
        records.insert(id, urls_for(&state.pool, subject).await?);
    }
    Ok(Json(Records { records }))
}
async fn replace_urls(
    tx: &mut Transaction<'_, Postgres>,
    subject: Uuid,
    urls: &[String],
) -> ApiResult<()> {
    sqlx::query("DELETE FROM provenance_urls WHERE subject_id=$1")
        .bind(subject)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::internal)?;
    for (ordinal, url) in urls.iter().enumerate() {
        sqlx::query("INSERT INTO provenance_urls(subject_id,ordinal,url) VALUES($1,$2,$3)")
            .bind(subject)
            .bind(ordinal as i16)
            .bind(url)
            .execute(&mut **tx)
            .await
            .map_err(ApiError::internal)?;
    }
    Ok(())
}
async fn set_record(
    State(state): State<AppState>,
    Json(input): Json<RecordInput>,
) -> ApiResult<Json<RecordOutput>> {
    let path = decode_id(&input.id)?;
    let urls = valid_urls(input.urls)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    if urls.is_empty() {
        sqlx::query("DELETE FROM provenance_subjects WHERE active_id=$1")
            .bind(&input.id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    } else {
        let subject: Uuid = sqlx::query_scalar("INSERT INTO provenance_subjects(id,active_id,active_path) VALUES($1,$2,$3) ON CONFLICT(active_id) DO UPDATE SET updated_at=now() RETURNING id").bind(Uuid::new_v4()).bind(&input.id).bind(path).fetch_one(&mut *tx).await.map_err(ApiError::internal)?;
        replace_urls(&mut tx, subject, &urls).await?;
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(RecordOutput { id: input.id, urls }))
}
async fn append_record(
    State(state): State<AppState>,
    Json(input): Json<AppendInput>,
) -> ApiResult<Json<RecordOutput>> {
    let url = valid_urls(vec![input.url])?.remove(0);
    let path = decode_id(&input.id)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let subject: Uuid = sqlx::query_scalar("INSERT INTO provenance_subjects(id,active_id,active_path) VALUES($1,$2,$3) ON CONFLICT(active_id) DO UPDATE SET updated_at=now() RETURNING id").bind(Uuid::new_v4()).bind(&input.id).bind(path).fetch_one(&mut *tx).await.map_err(ApiError::internal)?;
    sqlx::query("SELECT id FROM provenance_subjects WHERE id=$1 FOR UPDATE")
        .bind(subject)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM provenance_urls WHERE subject_id=$1")
        .bind(subject)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if count >= 50 {
        return Err(ApiError::bad(
            "too_many_urls",
            "A file can have at most 50 provenance URLs",
        ));
    }
    sqlx::query("INSERT INTO provenance_urls(subject_id,ordinal,url) VALUES($1,$2,$3) ON CONFLICT(subject_id,url) DO NOTHING").bind(subject).bind(count as i16).bind(url).execute(&mut *tx).await.map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    let urls = urls_for(&state.pool, subject).await?;
    Ok(Json(RecordOutput { id: input.id, urls }))
}
fn under(path: &[u8], prefix: &[u8]) -> bool {
    path == prefix || (path.starts_with(prefix) && path.get(prefix.len()) == Some(&b'/'))
}
fn joined(prefix: &[u8], suffix: &[u8]) -> Vec<u8> {
    if suffix.is_empty() {
        prefix.to_vec()
    } else {
        [prefix, b"/", suffix].concat()
    }
}
async fn lifecycle(
    State(state): State<AppState>,
    Json(input): Json<Lifecycle>,
) -> ApiResult<Json<Changes>> {
    let copy_operation = matches!(&input, Lifecycle::Copy { .. });
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    sqlx::query("SELECT pg_advisory_xact_lock(7349021)")
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let mut changes = Vec::new();
    match input {
        Lifecycle::Move {
            source_id,
            target_id,
        }
        | Lifecycle::Copy {
            source_id,
            target_id,
        } => {
            let copy = copy_operation;
            let source = decode_id(&source_id)?;
            let target = decode_id(&target_id)?;
            let rows=sqlx::query("SELECT id,active_id,active_path FROM provenance_subjects WHERE active_path IS NOT NULL").fetch_all(&mut *tx).await.map_err(ApiError::internal)?;
            for row in rows {
                let subject: Uuid = row.get("id");
                let old_id: String = row.get("active_id");
                let path: Vec<u8> = row.get("active_path");
                if !under(&path, &source) {
                    continue;
                }
                let suffix = &path[source.len()..];
                let suffix = suffix.strip_prefix(b"/").unwrap_or(suffix);
                let new_path = joined(&target, suffix);
                let new_id = encode_id(&new_path);
                let urls = sqlx::query_scalar(
                    "SELECT url FROM provenance_urls WHERE subject_id=$1 ORDER BY ordinal",
                )
                .bind(subject)
                .fetch_all(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
                if copy {
                    let new_subject = Uuid::new_v4();
                    sqlx::query("INSERT INTO provenance_subjects(id,active_id,active_path) VALUES($1,$2,$3)").bind(new_subject).bind(&new_id).bind(new_path).execute(&mut *tx).await.map_err(|_|ApiError::conflict("provenance_conflict","Destination already has provenance"))?;
                    replace_urls(&mut tx, new_subject, &urls).await?;
                } else {
                    sqlx::query("UPDATE provenance_subjects SET active_id=$1,active_path=$2,updated_at=now() WHERE id=$3").bind(&new_id).bind(new_path).bind(subject).execute(&mut *tx).await.map_err(ApiError::internal)?;
                    changes.push(RecordOutput {
                        id: old_id,
                        urls: Vec::new(),
                    });
                }
                changes.push(RecordOutput { id: new_id, urls });
            }
        }
        Lifecycle::Trash {
            source_id,
            trash_id,
        } => {
            let source = decode_id(&source_id)?;
            let rows=sqlx::query("SELECT id,active_id,active_path FROM provenance_subjects WHERE active_path IS NOT NULL").fetch_all(&mut *tx).await.map_err(ApiError::internal)?;
            for row in rows {
                let subject: Uuid = row.get("id");
                let old_id: String = row.get("active_id");
                let path: Vec<u8> = row.get("active_path");
                if !under(&path, &source) {
                    continue;
                }
                let suffix = path[source.len()..]
                    .strip_prefix(b"/")
                    .unwrap_or(&path[source.len()..])
                    .to_vec();
                sqlx::query("UPDATE provenance_subjects SET active_id=NULL,active_path=NULL,trash_id=$1,trash_suffix=$2,updated_at=now() WHERE id=$3").bind(trash_id).bind(suffix).bind(subject).execute(&mut *tx).await.map_err(ApiError::internal)?;
                changes.push(RecordOutput {
                    id: old_id,
                    urls: Vec::new(),
                });
            }
        }
        Lifecycle::Restore {
            trash_id,
            target_id,
        } => {
            let target = decode_id(&target_id)?;
            let rows =
                sqlx::query("SELECT id,trash_suffix FROM provenance_subjects WHERE trash_id=$1")
                    .bind(trash_id)
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(ApiError::internal)?;
            for row in rows {
                let subject: Uuid = row.get("id");
                let suffix: Vec<u8> = row.get("trash_suffix");
                let path = joined(&target, &suffix);
                let id = encode_id(&path);
                sqlx::query("UPDATE provenance_subjects SET active_id=$1,active_path=$2,trash_id=NULL,trash_suffix=NULL,updated_at=now() WHERE id=$3").bind(&id).bind(path).bind(subject).execute(&mut *tx).await.map_err(|_|ApiError::conflict("provenance_conflict","Restore destination already has provenance"))?;
                let urls = sqlx::query_scalar(
                    "SELECT url FROM provenance_urls WHERE subject_id=$1 ORDER BY ordinal",
                )
                .bind(subject)
                .fetch_all(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
                changes.push(RecordOutput { id, urls });
            }
        }
        Lifecycle::Purge { trash_id } => {
            sqlx::query("DELETE FROM provenance_subjects WHERE trash_id=$1")
                .bind(trash_id)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
        }
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(Changes { changes }))
}
async fn import_records(
    State(state): State<AppState>,
    Json(input): Json<ImportInput>,
) -> ApiResult<Json<ImportResult>> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM provenance_subjects")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if count > 0 {
        return Ok(Json(ImportResult {
            imported: 0,
            skipped: true,
        }));
    }
    let mut imported = 0;
    for (id, raw_urls) in input.records {
        let urls = valid_urls(raw_urls)?;
        if urls.is_empty() {
            continue;
        }
        let path = decode_id(&id)?;
        let subject = Uuid::new_v4();
        sqlx::query("INSERT INTO provenance_subjects(id,active_id,active_path) VALUES($1,$2,$3)")
            .bind(subject)
            .bind(id)
            .bind(path)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        replace_urls(&mut tx, subject, &urls).await?;
        imported += 1;
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(ImportResult {
        imported,
        skipped: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_deduplicates_urls() {
        assert_eq!(
            valid_urls(vec![
                " https://example.com/a ".into(),
                "https://example.com/a".into()
            ])
            .unwrap(),
            vec!["https://example.com/a"]
        );
        assert!(valid_urls(vec!["file:///tmp/source".into()]).is_err());
        assert!(
            valid_urls(
                (0..51)
                    .map(|index| format!("https://example.com/{index}"))
                    .collect()
            )
            .is_err()
        );
    }

    #[test]
    fn path_prefixes_respect_component_boundaries() {
        assert!(under(b"folder/file", b"folder"));
        assert!(!under(b"folder-two/file", b"folder"));
        assert_eq!(joined(b"target", b"nested/file"), b"target/nested/file");
    }
}
