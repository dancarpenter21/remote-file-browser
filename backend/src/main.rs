use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    io::SeekFrom,
    os::unix::ffi::{OsStrExt, OsStringExt},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Multipart, Path as AxumPath, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures_util::StreamExt;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, OwnedSemaphorePermit, RwLock, Semaphore, broadcast},
};
use tokio_util::io::ReaderStream;
use tower_http::trace::TraceLayer;
use tracing::{error, info, warn};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;
use uuid::Uuid;

const SESSION_COOKIE: &str = "rfb_session";
const SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const TERMINAL_TICKET_TTL: Duration = Duration::from_secs(30);
const TERMINAL_MAX_INPUT_BYTES: usize = 64 * 1024;
const TERMINAL_DEFAULT_ROWS: u16 = 24;
const TERMINAL_DEFAULT_COLS: u16 = 80;
const VFX_EDITOR_MAX_SOURCE_BYTES: u64 = 40 * 1024 * 1024 * 1024;

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    sessions: Arc<DashMap<String, Session>>,
    login_attempts: Arc<DashMap<String, Vec<SystemTime>>>,
    media_jobs: Arc<DashMap<String, MediaJob>>,
    direct_playable: Arc<DashMap<String, bool>>,
    extraction_jobs: Arc<DashMap<String, ExtractionJob>>,
    concatenation_jobs: Arc<DashMap<String, ConcatenationJob>>,
    provenance: Arc<RwLock<HashMap<String, Vec<String>>>>,
    provenance_write: Arc<Mutex<()>>,
    cache_index: Arc<RwLock<CacheIndex>>,
    cache_write: Arc<Mutex<()>>,
    cache_cleanup: Arc<Mutex<()>>,
    live_events: broadcast::Sender<LiveEvent>,
    provenance_api_token: Option<Arc<String>>,
    terminal_tickets: Arc<DashMap<String, TerminalTicket>>,
    terminal_slots: Arc<Semaphore>,
}

struct Config {
    root: PathBuf,
    root_canonical: PathBuf,
    trash: PathBuf,
    cache: PathBuf,
    username: String,
    admin_password: AdminPasswordSource,
    secure_cookies: bool,
    editor_max: u64,
    upload_max: u64,
    cache_max: u64,
    cache_age_days: u64,
    terminal_enabled: bool,
    terminal_shell: PathBuf,
    terminal_max_sessions: usize,
    vfx_editor_api_url: Option<String>,
}

#[derive(Clone)]
enum AdminPasswordSource {
    File(PathBuf),
    Static(String),
}

impl AdminPasswordSource {
    fn from_env() -> Result<Self, &'static str> {
        if let Ok(path) = std::env::var("RFB_ADMIN_PASSWORD_FILE") {
            return Ok(Self::File(PathBuf::from(path)));
        }
        std::env::var("RFB_ADMIN_PASSWORD")
            .map(Self::Static)
            .map_err(|_| "RFB_ADMIN_PASSWORD_FILE or RFB_ADMIN_PASSWORD is required")
    }

    async fn load(&self) -> std::io::Result<String> {
        Ok(match self {
            Self::File(path) => fs::read_to_string(path).await?.trim_end().to_string(),
            Self::Static(password) => password.clone(),
        })
    }
}

#[derive(Clone)]
struct TerminalTicket {
    session_token: String,
    directory: PathBuf,
    expires: SystemTime,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheIndex {
    records: HashMap<String, CacheRecord>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheRecord {
    kind: String,
    key: String,
    source_id: String,
    #[serde(default)]
    source_inode: u64,
    source_size: u64,
    source_modified_ns: u64,
    dimension: Option<u32>,
}

#[derive(Clone, Default, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct CacheCleanupReport {
    artifacts_removed: u64,
    records_removed: u64,
    bytes_reclaimed: u64,
}

#[derive(Clone)]
struct Session {
    csrf: String,
    expires: SystemTime,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
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

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Remote File Browser API",
        version = "1.0.0",
        description = "Authenticated filesystem management, media playback, and provenance automation API. Browser mutations require both the session cookie and CSRF header; provenance automation uses a bearer token."
    ),
    paths(
        health,
        login,
        session_info,
        logout,
        list_entries,
        metadata,
        get_provenance,
        set_provenance,
        submit_provenance,
        live_events,
        content,
        create_item,
        upload,
        operation,
        soft_delete,
        read_document,
        write_document,
        save_image_markup,
        list_trash,
        empty_trash,
        restore_trash,
        purge_trash,
        thumbnail,
        media_file,
        media_info,
        start_extraction,
        list_extraction_jobs,
        extraction_status,
        start_concatenation,
        list_concatenation_jobs,
        start_hls,
        list_media_jobs,
        request_cache_cleanup,
        auth_check,
        open_vfx_project,
        save_vfx_export,
        create_terminal_ticket,
        terminal_websocket,
        hls_status,
        hls_file
    ),
    components(schemas(
        Problem,
        LoginRequest,
        SessionResponse,
        Entry,
        EntryPage,
        Provenance,
        ProvenanceSubmission,
        ProvenanceEvent,
        CreateRequest,
        OperationRequest,
        DeleteRequest,
        TrashInfo,
        TrashEntry,
        RestoreRequest,
        Document,
        WriteDocument,
        HlsRequest,
        HlsResponse,
        MediaJob,
        MediaInfo,
        ExtractionRequest,
        ExtractionJob,
        ConcatenationRequest,
        ConcatenationJob,
        CacheCleanupReport,
        VfxProjectRequest,
        VfxProjectResponse,
        VfxExportRequest,
        VfxExportResponse,
        TerminalTicketRequest,
        TerminalTicketResponse
    )),
    modifiers(&SecurityAddon),
    tags(
        (name = "authentication", description = "Browser session management"),
        (name = "filesystem", description = "Root-confined file operations"),
        (name = "provenance", description = "File source metadata and live updates"),
        (name = "editor", description = "UTF-8 document editing"),
        (name = "trash", description = "Recoverable deletion"),
        (name = "media", description = "Previews and browser-compatible playback"),
        (name = "terminal", description = "Authenticated interactive container terminal"),
        (name = "system", description = "Service health")
    )
)]
struct ApiDoc;

struct SecurityAddon;

impl utoipa::Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::security::{
            ApiKey, ApiKeyValue, Http, HttpAuthScheme, SecurityScheme,
        };
        let components = openapi.components.get_or_insert_default();
        components.add_security_scheme(
            "sessionCookie",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::new(SESSION_COOKIE))),
        );
        components.add_security_scheme(
            "csrfToken",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new("x-csrf-token"))),
        );
        components.add_security_scheme(
            "provenanceToken",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
    }
}

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
    let cache_index = load_cache_index(&cache).await;
    let provenance_api_token = read_optional_token("RFB_PROVENANCE_API_TOKEN_FILE").await;
    let (live_event_tx, _) = broadcast::channel(512);

    let admin_password = AdminPasswordSource::from_env().expect("administrator password source");
    admin_password
        .load()
        .await
        .expect("load administrator password secret");

    let config = Config {
        root,
        root_canonical,
        trash,
        cache,
        username: env_string("RFB_ADMIN_USERNAME", "admin"),
        admin_password,
        secure_cookies: env_bool("RFB_SECURE_COOKIES", true),
        editor_max: env_u64("RFB_EDITOR_MAX_BYTES", 5 * 1024 * 1024),
        upload_max: env_u64("RFB_UPLOAD_MAX_BYTES", 20 * 1024 * 1024 * 1024),
        cache_max: env_u64("RFB_CACHE_MAX_BYTES", 10 * 1024 * 1024 * 1024),
        cache_age_days: env_u64("RFB_CACHE_MAX_AGE_DAYS", 30),
        terminal_enabled: env_bool("RFB_TERMINAL_ENABLED", true),
        terminal_shell: PathBuf::from(env_string("RFB_TERMINAL_SHELL", "/bin/zsh")),
        terminal_max_sessions: env_usize("RFB_TERMINAL_MAX_SESSIONS", 4).max(1),
        vfx_editor_api_url: std::env::var("RFB_VFX_EDITOR_API_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim_end_matches('/').to_string()),
    };
    let terminal_max_sessions = config.terminal_max_sessions;
    let body_limit =
        usize::try_from(config.upload_max.min(usize::MAX as u64)).unwrap_or(usize::MAX);
    let state = AppState {
        config: Arc::new(config),
        sessions: Arc::new(DashMap::new()),
        login_attempts: Arc::new(DashMap::new()),
        media_jobs: Arc::new(DashMap::new()),
        direct_playable: Arc::new(DashMap::new()),
        extraction_jobs: Arc::new(DashMap::new()),
        concatenation_jobs: Arc::new(DashMap::new()),
        provenance: Arc::new(RwLock::new(provenance)),
        provenance_write: Arc::new(Mutex::new(())),
        cache_index: Arc::new(RwLock::new(cache_index)),
        cache_write: Arc::new(Mutex::new(())),
        cache_cleanup: Arc::new(Mutex::new(())),
        live_events: live_event_tx,
        provenance_api_token: provenance_api_token.map(Arc::new),
        terminal_tickets: Arc::new(DashMap::new()),
        terminal_slots: Arc::new(Semaphore::new(terminal_max_sessions)),
    };

    spawn_cache_cleanup(state.clone());
    spawn_filesystem_watcher(state.clone());

    let api = Router::new()
        .route("/auth/login", post(login))
        .route("/auth/session", get(session_info))
        .route("/auth/check", get(auth_check))
        .route("/auth/logout", post(logout))
        .route("/fs/entries", get(list_entries))
        .route("/fs/metadata", get(metadata))
        .route(
            "/fs/provenance",
            get(get_provenance)
                .put(set_provenance)
                .post(submit_provenance),
        )
        .route("/events", get(live_events))
        .route("/fs/content", get(content))
        .route("/fs/items", post(create_item))
        .route("/fs/uploads", post(upload))
        .route("/fs/operations", post(operation))
        .route("/fs/trash", post(soft_delete))
        .route("/editor/document", get(read_document).put(write_document))
        .route("/editor/image-markup", post(save_image_markup))
        .route("/trash", get(list_trash).delete(empty_trash))
        .route("/trash/{id}/restore", post(restore_trash))
        .route("/trash/{id}", delete(purge_trash))
        .route("/previews/thumbnail", get(thumbnail))
        .route("/media/file", get(media_file))
        .route("/media/info", get(media_info))
        .route(
            "/media/extractions",
            post(start_extraction).get(list_extraction_jobs),
        )
        .route("/media/extractions/{key}", get(extraction_status))
        .route(
            "/media/concatenations",
            post(start_concatenation).get(list_concatenation_jobs),
        )
        .route("/media/hls", post(start_hls))
        .route("/media/jobs", get(list_media_jobs))
        .route("/media/cache/cleanup", post(request_cache_cleanup))
        .route("/integrations/vfx/projects", post(open_vfx_project))
        .route("/integrations/vfx/exports", post(save_vfx_export))
        .route("/terminal/tickets", post(create_terminal_ticket))
        .route("/terminal/ws", get(terminal_websocket))
        .route("/media/hls/{key}/status", get(hls_status))
        .route("/media/hls/{key}/{file}", get(hls_file));

    let app = Router::new()
        .route("/healthz", get(health))
        .nest("/api/v1", api)
        .merge(SwaggerUi::new("/api/docs").url("/api/openapi.json", ApiDoc::openapi()))
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    info!(address = %listener.local_addr().unwrap(), "remote file browser backend started");
    axum::serve(listener, app).await.unwrap();
}

#[utoipa::path(get, path = "/healthz", tag = "system", responses((status = 200, body = String)))]
async fn health() -> &'static str {
    "ok"
}

async fn read_optional_token(variable: &str) -> Option<String> {
    let path = std::env::var(variable)
        .ok()
        .filter(|path| !path.trim().is_empty())?;
    let token = fs::read_to_string(path)
        .await
        .expect("read provenance API token secret")
        .trim()
        .to_string();
    assert!(
        token.chars().count() >= 32,
        "provenance API token must contain at least 32 characters"
    );
    Some(token)
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
fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[derive(Deserialize, utoipa::ToSchema)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    authenticated: bool,
    username: Option<String>,
    csrf_token: Option<String>,
    terminal_enabled: bool,
    vfx_editor_enabled: bool,
}

#[utoipa::path(post, path = "/api/v1/auth/login", tag = "authentication", request_body = LoginRequest, responses((status = 200, body = SessionResponse), (status = 401, body = Problem), (status = 429, body = Problem)))]
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
    let expected_password = state
        .config
        .admin_password
        .load()
        .await
        .map_err(ApiError::internal)?;
    let password_valid = bool::from(
        input
            .password
            .as_bytes()
            .ct_eq(expected_password.as_bytes()),
    );
    drop(expected_password);
    let valid = input.username == state.config.username && password_valid;
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
            terminal_enabled: state.config.terminal_enabled,
            vfx_editor_enabled: state.config.vfx_editor_api_url.is_some(),
        }),
    ))
}

#[utoipa::path(get, path = "/api/v1/auth/session", tag = "authentication", responses((status = 200, body = SessionResponse)))]
async fn session_info(State(state): State<AppState>, jar: CookieJar) -> Json<SessionResponse> {
    match require_session(&state, &jar) {
        Ok(session) => Json(SessionResponse {
            authenticated: true,
            username: Some(state.config.username.clone()),
            csrf_token: Some(session.csrf),
            terminal_enabled: state.config.terminal_enabled,
            vfx_editor_enabled: state.config.vfx_editor_api_url.is_some(),
        }),
        Err(_) => Json(SessionResponse {
            authenticated: false,
            username: None,
            csrf_token: None,
            terminal_enabled: state.config.terminal_enabled,
            vfx_editor_enabled: state.config.vfx_editor_api_url.is_some(),
        }),
    }
}

#[utoipa::path(get, path = "/api/v1/auth/check", tag = "authentication", security(("sessionCookie" = [])), responses((status = 204), (status = 401, body = Problem)))]
async fn auth_check(State(state): State<AppState>, jar: CookieJar) -> ApiResult<StatusCode> {
    require_session(&state, &jar)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/v1/auth/logout", tag = "authentication", security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 204), (status = 401, body = Problem), (status = 403, body = Problem)))]
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
    Ok(require_session_with_token(state, jar)?.1)
}

fn require_session_with_token(state: &AppState, jar: &CookieJar) -> ApiResult<(String, Session)> {
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
    Ok((token, session.clone()))
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

#[derive(Clone, Serialize, utoipa::ToSchema)]
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
    has_provenance: bool,
    browser_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    child_file_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    child_directory_count: Option<usize>,
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

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct EntryPage {
    entries: Vec<Entry>,
    total: usize,
    next_offset: Option<usize>,
}

#[utoipa::path(get, path = "/api/v1/fs/entries", tag = "filesystem", params(("id" = Option<String>, Query), ("offset" = Option<usize>, Query), ("limit" = Option<usize>, Query), ("hidden" = Option<bool>, Query), ("sort" = Option<String>, Query), ("direction" = Option<String>, Query)), security(("sessionCookie" = [])), responses((status = 200, body = EntryPage), (status = 401, body = Problem)))]
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
        entries.push(entry_from_path(&state, item.path()).await?);
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
    if let Some(index) = entries
        .iter()
        .position(|entry| is_readme_file(&entry.name, &entry.kind))
    {
        let readme = entries.remove(index);
        entries.insert(0, readme);
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

fn is_readme_file(name: &str, kind: &str) -> bool {
    name == "README.md" && kind == "file"
}

#[derive(Deserialize)]
struct IdQuery {
    id: String,
}

#[utoipa::path(get, path = "/api/v1/fs/metadata", tag = "filesystem", params(("id" = String, Query)), security(("sessionCookie" = [])), responses((status = 200, body = Entry), (status = 400, body = Problem), (status = 404, body = Problem)))]
async fn metadata(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<IdQuery>,
) -> ApiResult<Json<Entry>> {
    require_session(&state, &jar)?;
    let path = resolve_existing(&state.config, &query.id).await?;
    let mut entry = entry_from_path(&state, path.clone()).await?;
    if entry.kind == "directory" {
        match directory_child_counts(&path, &state.config).await {
            Ok((files, directories)) => {
                entry.child_file_count = Some(files);
                entry.child_directory_count = Some(directories);
            }
            Err(error) => {
                warn!(%error, path = %path.display(), "could not count directory contents");
            }
        }
    }
    Ok(Json(entry))
}

async fn directory_child_counts(
    directory: &Path,
    config: &Config,
) -> std::io::Result<(usize, usize)> {
    let mut files = 0;
    let mut directories = 0;
    let mut reader = fs::read_dir(directory).await?;
    while let Some(item) = reader.next_entry().await? {
        if is_internal(directory, config, &item.file_name()) {
            continue;
        }
        if item.file_type().await?.is_dir() {
            directories += 1;
        } else {
            files += 1;
        }
    }
    Ok((files, directories))
}

#[derive(Serialize, Deserialize, Clone, Default, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct Provenance {
    urls: Vec<String>,
}

#[derive(Deserialize, utoipa::ToSchema)]
struct ProvenanceSubmission {
    path: String,
    url: String,
}

#[derive(Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ProvenanceEvent {
    id: String,
    path: String,
    urls: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum LiveEvent {
    Resync,
    Filesystem {
        directory_ids: Vec<String>,
    },
    Provenance {
        change: ProvenanceEvent,
    },
    MediaSnapshot {
        jobs: Vec<MediaJob>,
        extractions: Vec<ExtractionJob>,
        concatenations: Vec<ConcatenationJob>,
    },
    MediaJob {
        job: Box<MediaJob>,
    },
    ExtractionJob {
        job: Box<ExtractionJob>,
    },
    ConcatenationJob {
        job: Box<ConcatenationJob>,
    },
    CacheCleanup {
        state: String,
        report: Option<CacheCleanupReport>,
        error: Option<String>,
    },
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

async fn load_cache_index(cache: &Path) -> CacheIndex {
    match fs::read(cache.join("cache-index.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            warn!(%error, "could not parse cache index");
            CacheIndex::default()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CacheIndex::default(),
        Err(error) => {
            warn!(%error, "could not read cache index");
            CacheIndex::default()
        }
    }
}

fn source_modified_ns(meta: &std::fs::Metadata) -> u64 {
    let value = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
    value.max(0).min(i128::from(u64::MAX)) as u64
}

fn cache_record_id(kind: &str, key: &str) -> String {
    format!("{kind}:{key}")
}

fn cache_record_matches(
    record: &CacheRecord,
    kind: &str,
    id: &str,
    meta: &std::fs::Metadata,
    dimension: Option<u32>,
) -> bool {
    record.kind == kind
        && record.source_id == id
        && record.source_inode == meta.ino()
        && record.source_size == meta.len()
        && record.source_modified_ns == source_modified_ns(meta)
        && record.dimension == dimension
}

async fn find_cache_key(
    state: &AppState,
    kind: &str,
    id: &str,
    meta: &std::fs::Metadata,
    dimension: Option<u32>,
) -> Option<String> {
    state
        .cache_index
        .read()
        .await
        .records
        .values()
        .find(|record| cache_record_matches(record, kind, id, meta, dimension))
        .map(|record| record.key.clone())
}

async fn persist_cache_index(cache: &Path, index: &CacheIndex) -> ApiResult<()> {
    let bytes = serde_json::to_vec_pretty(index).map_err(ApiError::internal)?;
    let temporary = cache.join(".cache-index.json.tmp");
    fs::write(&temporary, bytes).await?;
    fs::rename(temporary, cache.join("cache-index.json")).await?;
    Ok(())
}

async fn register_cache_record(state: &AppState, record: CacheRecord) -> ApiResult<()> {
    let record_id = cache_record_id(&record.kind, &record.key);
    if state
        .cache_index
        .read()
        .await
        .records
        .get(&record_id)
        .is_some_and(|existing| {
            existing.kind == record.kind
                && existing.key == record.key
                && existing.source_id == record.source_id
                && existing.source_inode == record.source_inode
                && existing.source_size == record.source_size
                && existing.source_modified_ns == record.source_modified_ns
                && existing.dimension == record.dimension
        })
    {
        return Ok(());
    }
    let _write = state.cache_write.lock().await;
    let mut index = state.cache_index.read().await.clone();
    index.records.insert(record_id, record);
    persist_cache_index(&state.config.cache, &index).await?;
    *state.cache_index.write().await = index;
    Ok(())
}

async fn persist_provenance_records(
    cache: &Path,
    records: &HashMap<String, Vec<String>>,
) -> ApiResult<()> {
    let bytes = serde_json::to_vec_pretty(records).map_err(ApiError::internal)?;
    let target = cache.join("provenance.json");
    let temporary = cache.join(".provenance.json.tmp");
    fs::write(&temporary, bytes).await?;
    fs::rename(temporary, target).await?;
    Ok(())
}

fn normalize_provenance_urls(input: Vec<String>) -> ApiResult<Vec<String>> {
    if input.len() > 50 {
        return Err(ApiError::bad(
            "too_many_urls",
            "A file can have at most 50 provenance URLs",
        ));
    }
    let mut urls = Vec::with_capacity(input.len());
    for value in input {
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
    Ok(urls)
}

async fn commit_provenance(
    state: &AppState,
    id: String,
    path: String,
    urls: Vec<String>,
) -> ApiResult<Provenance> {
    let urls = normalize_provenance_urls(urls)?;
    let _write = state.provenance_write.lock().await;
    let mut records = state.provenance.read().await.clone();
    let previous = records.get(&id).cloned().unwrap_or_default();
    if previous == urls {
        return Ok(Provenance { urls });
    }
    if urls.is_empty() {
        records.remove(&id);
    } else {
        records.insert(id.clone(), urls.clone());
    }
    persist_provenance_records(&state.config.cache, &records).await?;
    *state.provenance.write().await = records;
    drop(_write);
    let _ = state.live_events.send(LiveEvent::Provenance {
        change: ProvenanceEvent {
            id,
            path,
            urls: urls.clone(),
        },
    });
    Ok(Provenance { urls })
}

async fn append_provenance(
    state: &AppState,
    id: String,
    path: String,
    url: String,
) -> ApiResult<Provenance> {
    let url = normalize_provenance_urls(vec![url])?
        .into_iter()
        .next()
        .expect("one validated provenance URL");
    let _write = state.provenance_write.lock().await;
    let mut records = state.provenance.read().await.clone();
    let urls = records.entry(id.clone()).or_default();
    if urls.contains(&url) {
        return Ok(Provenance { urls: urls.clone() });
    }
    if urls.len() >= 50 {
        return Err(ApiError::bad(
            "too_many_urls",
            "A file can have at most 50 provenance URLs",
        ));
    }
    urls.push(url);
    let urls = urls.clone();
    persist_provenance_records(&state.config.cache, &records).await?;
    *state.provenance.write().await = records;
    drop(_write);
    let _ = state.live_events.send(LiveEvent::Provenance {
        change: ProvenanceEvent {
            id,
            path,
            urls: urls.clone(),
        },
    });
    Ok(Provenance { urls })
}

#[utoipa::path(get, path = "/api/v1/fs/provenance", tag = "provenance", params(("id" = String, Query)), security(("sessionCookie" = [])), responses((status = 200, body = Provenance), (status = 400, body = Problem), (status = 404, body = Problem)))]
async fn get_provenance(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<IdQuery>,
) -> ApiResult<Json<Provenance>> {
    require_session(&state, &jar)?;
    let path = resolve_existing(&state.config, &query.id).await?;
    if !fs::symlink_metadata(&path).await?.is_file() {
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

#[utoipa::path(put, path = "/api/v1/fs/provenance", tag = "provenance", params(("id" = String, Query), ("x-csrf-token" = String, Header)), request_body = Provenance, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 200, body = Provenance), (status = 400, body = Problem), (status = 401, body = Problem), (status = 403, body = Problem)))]
async fn set_provenance(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(query): Query<IdQuery>,
    Json(input): Json<Provenance>,
) -> ApiResult<Json<Provenance>> {
    require_csrf(&state, &jar, &headers)?;
    let path = resolve_existing(&state.config, &query.id).await?;
    if !fs::symlink_metadata(&path).await?.is_file() {
        return Err(ApiError::bad(
            "not_file",
            "Provenance can only be attached to files",
        ));
    }
    let relative = path
        .strip_prefix(&state.config.root)
        .map_err(ApiError::internal)?;
    Ok(Json(
        commit_provenance(
            &state,
            query.id,
            format!("/fs-root/{}", relative.to_string_lossy()),
            input.urls,
        )
        .await?,
    ))
}

fn require_provenance_token(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    let token = state.provenance_api_token.as_ref().ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "provenance_api_disabled",
            "The provenance submission API is not configured".into(),
        )
    })?;
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    let valid = supplied.len() == token.len()
        && supplied.as_bytes().ct_eq(token.as_bytes()).unwrap_u8() == 1;
    if !valid {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Invalid API token".into(),
        ));
    }
    Ok(())
}

fn submitted_path_id(path: &str) -> ApiResult<String> {
    if path.starts_with("/fs-root/") || path == "/fs-root" {
        return Err(ApiError::bad(
            "invalid_path",
            "Use a path relative to the filesystem root",
        ));
    }
    let relative = path.strip_prefix('/').unwrap_or(path);
    if relative.is_empty()
        || relative.contains('\0')
        || relative.starts_with('/')
        || Path::new(relative)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ApiError::bad(
            "invalid_path",
            "Use a path relative to the filesystem root",
        ));
    }
    Ok(encode_path(OsStr::new(relative)))
}

#[utoipa::path(post, path = "/api/v1/fs/provenance", tag = "provenance", request_body = ProvenanceSubmission, security(("provenanceToken" = [])), responses((status = 200, body = Provenance), (status = 400, body = Problem), (status = 401, body = Problem), (status = 404, body = Problem), (status = 503, body = Problem)))]
async fn submit_provenance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ProvenanceSubmission>,
) -> ApiResult<Json<Provenance>> {
    require_provenance_token(&state, &headers)?;
    let id = submitted_path_id(&input.path)?;
    let path = resolve_existing(&state.config, &id).await?;
    if !fs::symlink_metadata(&path).await?.is_file() {
        return Err(ApiError::bad(
            "not_file",
            "Provenance can only be attached to files",
        ));
    }
    let relative = path
        .strip_prefix(&state.config.root)
        .map_err(ApiError::internal)?;
    Ok(Json(
        append_provenance(
            &state,
            id,
            format!("/fs-root/{}", relative.to_string_lossy()),
            input.url,
        )
        .await?,
    ))
}

fn media_snapshot(state: &AppState) -> LiveEvent {
    let mut jobs = state
        .media_jobs
        .iter()
        .map(|job| job.value().clone())
        .collect::<Vec<_>>();
    jobs.sort_by_key(|job| std::cmp::Reverse(job.started_at));
    jobs.truncate(20);
    let mut extractions = state
        .extraction_jobs
        .iter()
        .map(|job| job.value().clone())
        .collect::<Vec<_>>();
    extractions.sort_by_key(|job| std::cmp::Reverse(job.started_at));
    extractions.truncate(20);
    let mut concatenations = state
        .concatenation_jobs
        .iter()
        .map(|job| job.value().clone())
        .collect::<Vec<_>>();
    concatenations.sort_by_key(|job| std::cmp::Reverse(job.started_at));
    concatenations.truncate(20);
    LiveEvent::MediaSnapshot {
        jobs,
        extractions,
        concatenations,
    }
}

async fn send_live_event(socket: &mut WebSocket, event: &LiveEvent) -> bool {
    let Ok(json) = serde_json::to_string(event) else {
        return false;
    };
    socket.send(Message::Text(json.into())).await.is_ok()
}

async fn live_socket(mut socket: WebSocket, state: AppState) {
    let mut events = state.live_events.subscribe();
    if !send_live_event(&mut socket, &LiveEvent::Resync).await
        || !send_live_event(&mut socket, &media_snapshot(&state)).await
    {
        return;
    }
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() { return; }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                _ => {}
            },
            event = events.recv() => match event {
                Ok(event) => if !send_live_event(&mut socket, &event).await { return; },
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if !send_live_event(&mut socket, &LiveEvent::Resync).await
                        || !send_live_event(&mut socket, &media_snapshot(&state)).await
                    { return; }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

#[utoipa::path(get, path = "/api/v1/events", tag = "system", security(("sessionCookie" = [])), responses((status = 101, description = "Authenticated WebSocket stream for filesystem, provenance, media, and cache events"), (status = 401, body = Problem)))]
async fn live_events(
    State(state): State<AppState>,
    jar: CookieJar,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    require_session(&state, &jar)?;
    Ok(upgrade
        .on_upgrade(move |socket| live_socket(socket, state))
        .into_response())
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct TerminalTicketRequest {
    directory_id: String,
}

#[derive(Serialize, utoipa::ToSchema)]
struct TerminalTicketResponse {
    ticket: String,
}

#[derive(Deserialize)]
struct TerminalSocketQuery {
    ticket: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalServerMessage<'a> {
    Ready,
    Exit { code: Option<i32> },
    Error { message: &'a str },
}

fn terminal_disabled() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "terminal_disabled",
        "The integrated terminal is disabled".into(),
    )
}

fn prune_terminal_tickets_for_session(state: &AppState, now: SystemTime, session_token: &str) {
    state
        .terminal_tickets
        .retain(|_, ticket| ticket.expires > now && ticket.session_token != session_token);
}

fn take_terminal_ticket(
    state: &AppState,
    ticket: &str,
    session_token: &str,
    now: SystemTime,
) -> ApiResult<TerminalTicket> {
    let (_, ticket) = state.terminal_tickets.remove(ticket).ok_or_else(|| {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "invalid_terminal_ticket",
            "The terminal ticket is invalid or has already been used".into(),
        )
    })?;
    if ticket.expires <= now || ticket.session_token != session_token {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "invalid_terminal_ticket",
            "The terminal ticket is invalid or expired".into(),
        ));
    }
    Ok(ticket)
}

#[utoipa::path(post, path = "/api/v1/terminal/tickets", tag = "terminal", params(("x-csrf-token" = String, Header)), request_body = TerminalTicketRequest, security(("sessionCookie" = []), ("csrfToken" = [])), responses((status = 200, body = TerminalTicketResponse), (status = 400, body = Problem), (status = 401, body = Problem), (status = 403, body = Problem), (status = 503, body = Problem)))]
async fn create_terminal_ticket(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(input): Json<TerminalTicketRequest>,
) -> ApiResult<Json<TerminalTicketResponse>> {
    if !state.config.terminal_enabled {
        return Err(terminal_disabled());
    }
    let _ = require_csrf(&state, &jar, &headers)?;
    let session_token = jar
        .get(SESSION_COOKIE)
        .expect("validated session has a cookie")
        .value()
        .to_string();
    let directory = resolve_existing(&state.config, &input.directory_id).await?;
    if !fs::symlink_metadata(&directory).await?.is_dir() {
        return Err(ApiError::bad(
            "not_directory",
            "A terminal can only start in a directory",
        ));
    }
    let now = SystemTime::now();
    prune_terminal_tickets_for_session(&state, now, &session_token);
    let ticket = random_token();
    state.terminal_tickets.insert(
        ticket.clone(),
        TerminalTicket {
            session_token,
            directory,
            expires: now + TERMINAL_TICKET_TTL,
        },
    );
    Ok(Json(TerminalTicketResponse { ticket }))
}

#[utoipa::path(get, path = "/api/v1/terminal/ws", tag = "terminal", params(("ticket" = String, Query)), security(("sessionCookie" = [])), responses((status = 101, description = "One-time-ticket authenticated terminal WebSocket"), (status = 401, body = Problem), (status = 429, body = Problem), (status = 503, body = Problem)))]
async fn terminal_websocket(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<TerminalSocketQuery>,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    if !state.config.terminal_enabled {
        return Err(terminal_disabled());
    }
    let (session_token, _) = require_session_with_token(&state, &jar)?;
    let permit = Arc::clone(&state.terminal_slots)
        .try_acquire_owned()
        .map_err(|_| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "terminal_capacity",
                "The maximum number of terminal sessions is already running".into(),
            )
        })?;
    let ticket = take_terminal_ticket(&state, &query.ticket, &session_token, SystemTime::now())?;
    Ok(upgrade
        .max_message_size(TERMINAL_MAX_INPUT_BYTES)
        .max_frame_size(TERMINAL_MAX_INPUT_BYTES)
        .on_upgrade(move |socket| {
            terminal_socket(socket, state, session_token, ticket.directory, permit)
        })
        .into_response())
}

fn parse_terminal_client_message(text: &str) -> Result<TerminalClientMessage, &'static str> {
    let message: TerminalClientMessage =
        serde_json::from_str(text).map_err(|_| "Invalid terminal message")?;
    match &message {
        TerminalClientMessage::Input { data } if data.len() > TERMINAL_MAX_INPUT_BYTES => {
            Err("Terminal input is too large")
        }
        TerminalClientMessage::Resize { cols, rows }
            if !(2..=500).contains(cols) || !(1..=200).contains(rows) =>
        {
            Err("Invalid terminal size")
        }
        _ => Ok(message),
    }
}

async fn send_terminal_control(socket: &mut WebSocket, message: TerminalServerMessage<'_>) -> bool {
    let Ok(json) = serde_json::to_string(&message) else {
        return false;
    };
    socket.send(Message::Text(json.into())).await.is_ok()
}

fn terminal_session_active(state: &AppState, token: &str) -> bool {
    state
        .sessions
        .get(token)
        .is_some_and(|session| session.expires >= SystemTime::now())
}

fn signal_terminal_group(pid: Option<u32>, signal: nix::sys::signal::Signal) {
    let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) else {
        return;
    };
    let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid), signal);
}

async fn stop_terminal_process(child: &mut tokio::process::Child, pid: Option<u32>) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    signal_terminal_group(pid, nix::sys::signal::Signal::SIGHUP);
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        signal_terminal_group(pid, nix::sys::signal::Signal::SIGKILL);
        let _ = child.wait().await;
    }
}

fn start_terminal_process(
    config: &Config,
    directory: &Path,
) -> pty_process::Result<(pty_process::Pty, tokio::process::Child)> {
    let (pty, pts) = pty_process::open()?;
    pty.resize(pty_process::Size::new(
        TERMINAL_DEFAULT_ROWS,
        TERMINAL_DEFAULT_COLS,
    ))?;
    let shell = &config.terminal_shell;
    let child = pty_process::Command::new(shell)
        .arg("-l")
        .current_dir(directory)
        .env("HOME", &config.root)
        .env("SHELL", shell)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .kill_on_drop(true)
        .spawn(pts)?;
    Ok((pty, child))
}

async fn terminal_socket(
    mut socket: WebSocket,
    state: AppState,
    session_token: String,
    directory: PathBuf,
    _permit: OwnedSemaphorePermit,
) {
    let shell = state.config.terminal_shell.clone();
    let (pty, mut child) = match start_terminal_process(&state.config, &directory) {
        Ok(process) => process,
        Err(error) => {
            warn!(%error, shell = %shell.display(), "could not spawn terminal shell");
            let _ = send_terminal_control(
                &mut socket,
                TerminalServerMessage::Error {
                    message: "The configured terminal shell could not be started",
                },
            )
            .await;
            return;
        }
    };
    let pid = child.id();
    let (mut reader, mut writer) = pty.into_split();
    let mut output = [0_u8; 16 * 1024];
    let mut session_check = tokio::time::interval(Duration::from_secs(5));
    session_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut finished = false;
    if !send_terminal_control(&mut socket, TerminalServerMessage::Ready).await {
        stop_terminal_process(&mut child, pid).await;
        return;
    }
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => match parse_terminal_client_message(text.as_str()) {
                    Ok(TerminalClientMessage::Input { data }) => {
                        if writer.write_all(data.as_bytes()).await.is_err() { break; }
                    }
                    Ok(TerminalClientMessage::Resize { cols, rows }) => {
                        if writer.resize(pty_process::Size::new(rows, cols)).is_err() { break; }
                    }
                    Err(message) => {
                        let _ = send_terminal_control(&mut socket, TerminalServerMessage::Error { message }).await;
                        break;
                    }
                },
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() { break; }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {
                    let _ = send_terminal_control(&mut socket, TerminalServerMessage::Error { message: "Unsupported terminal message" }).await;
                    break;
                }
            },
            read = reader.read(&mut output) => match read {
                Ok(0) | Err(_) => {
                    if let Ok(Ok(status)) = tokio::time::timeout(Duration::from_secs(1), child.wait()).await {
                        let _ = send_terminal_control(&mut socket, TerminalServerMessage::Exit { code: status.code() }).await;
                        finished = true;
                    }
                    break;
                }
                Ok(read) => if socket.send(Message::Binary(output[..read].to_vec().into())).await.is_err() { break; },
            },
            status = child.wait() => {
                let code = status.ok().and_then(|status| status.code());
                let _ = send_terminal_control(&mut socket, TerminalServerMessage::Exit { code }).await;
                finished = true;
                break;
            },
            _ = session_check.tick() => {
                if !terminal_session_active(&state, &session_token) { break; }
            }
        }
    }
    if !finished {
        stop_terminal_process(&mut child, pid).await;
    }
    let _ = socket.send(Message::Close(None)).await;
}

fn spawn_filesystem_watcher(state: AppState) {
    std::thread::spawn(move || {
        let root = state.config.root_canonical.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                error!(%error, "could not create filesystem watcher");
                return;
            }
        };
        if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
            error!(%error, path = %root.display(), "could not watch filesystem root");
            return;
        }
        info!(path = %root.display(), "watching filesystem root for live UI updates");

        loop {
            let first = match rx.recv() {
                Ok(event) => event,
                Err(_) => return,
            };
            let mut batch = vec![first];
            while let Ok(event) = rx.recv_timeout(Duration::from_millis(150)) {
                batch.push(event);
            }
            let mut directory_ids = HashSet::new();
            let mut resync = false;
            for result in batch {
                match result {
                    Ok(event) if matches!(event.kind, EventKind::Access(_)) => {}
                    Ok(event) => {
                        for path in event.paths {
                            let Ok(relative) = path.strip_prefix(&root) else {
                                resync = true;
                                continue;
                            };
                            if relative.starts_with(".cache/remote-file-browser")
                                || relative.starts_with(".trash")
                            {
                                continue;
                            }
                            let parent = relative.parent().unwrap_or(Path::new(""));
                            directory_ids.insert(encode_path(parent.as_os_str()));
                        }
                    }
                    Err(error) => {
                        warn!(%error, "filesystem watcher reported an error");
                        resync = true;
                    }
                }
            }
            if resync {
                directory_ids.insert(String::new());
            }
            if !directory_ids.is_empty() {
                let mut directory_ids = directory_ids.into_iter().collect::<Vec<_>>();
                directory_ids.sort();
                let _ = state
                    .live_events
                    .send(LiveEvent::Filesystem { directory_ids });
            }
        }
    });
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
    let _write = state.provenance_write.lock().await;
    let mut records = state.provenance.read().await.clone();
    let changes = records
        .iter()
        .filter_map(|(id, urls)| {
            let path = decode_path(id).ok()?;
            let suffix = path.strip_prefix(source_relative).ok()?;
            let new_path = if suffix.as_os_str().is_empty() {
                target_relative.to_path_buf()
            } else {
                target_relative.join(suffix)
            };
            Some((
                id.clone(),
                path,
                encode_path(new_path.as_os_str()),
                new_path,
                urls.clone(),
            ))
        })
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return Ok(());
    }
    let mut events = Vec::new();
    for (old, old_path, new, new_path, urls) in changes {
        if !copy {
            records.remove(&old);
            events.push(ProvenanceEvent {
                id: old,
                path: format!("/fs-root/{}", old_path.to_string_lossy()),
                urls: Vec::new(),
            });
        }
        records.insert(new.clone(), urls.clone());
        events.push(ProvenanceEvent {
            id: new,
            path: format!("/fs-root/{}", new_path.to_string_lossy()),
            urls,
        });
    }
    persist_provenance_records(&state.config.cache, &records).await?;
    *state.provenance.write().await = records;
    drop(_write);
    for event in events {
        let _ = state
            .live_events
            .send(LiveEvent::Provenance { change: event });
    }
    Ok(())
}

fn remapped_source_id(config: &Config, id: &str, source: &Path, target: &Path) -> Option<String> {
    let path = config.root.join(decode_path(id).ok()?);
    let suffix = path.strip_prefix(source).ok()?;
    let remapped = if suffix.as_os_str().is_empty() {
        target.to_path_buf()
    } else {
        target.join(suffix)
    };
    Some(encode_path(
        remapped.strip_prefix(&config.root).ok()?.as_os_str(),
    ))
}

fn cache_artifact_path(cache: &Path, record: &CacheRecord) -> PathBuf {
    if record.kind == "hls" {
        cache.join("hls").join(&record.key)
    } else {
        cache
            .join("thumbnails")
            .join(format!("{}.webp", record.key))
    }
}

async fn invalidate_cache_prefix(state: &AppState, path: &Path) -> ApiResult<()> {
    let _write = state.cache_write.lock().await;
    let mut index = state.cache_index.read().await.clone();
    let removed = index
        .records
        .iter()
        .filter_map(|(record_id, record)| {
            let source = state.config.root.join(decode_path(&record.source_id).ok()?);
            source
                .starts_with(path)
                .then_some((record_id.clone(), record.clone()))
        })
        .collect::<Vec<_>>();
    for (record_id, _) in &removed {
        index.records.remove(record_id);
    }
    persist_cache_index(&state.config.cache, &index).await?;
    *state.cache_index.write().await = index;
    drop(_write);
    for (_, record) in removed {
        let active = record.kind == "hls"
            && state
                .media_jobs
                .get(&record.key)
                .is_some_and(|job| job.status == "working");
        if active {
            continue;
        }
        let artifact = cache_artifact_path(&state.config.cache, &record);
        if record.kind == "hls" {
            let _ = fs::remove_dir_all(artifact).await;
        } else {
            let _ = fs::remove_file(artifact).await;
        }
    }
    Ok(())
}

async fn remap_cache(state: &AppState, source: &Path, target: &Path) -> ApiResult<()> {
    let _write = state.cache_write.lock().await;
    let mut index = state.cache_index.read().await.clone();
    for record in index.records.values_mut() {
        let Some(new_id) = remapped_source_id(&state.config, &record.source_id, source, target)
        else {
            continue;
        };
        let new_path = state.config.root.join(decode_path(&new_id)?);
        let meta = match fs::metadata(&new_path).await {
            Ok(meta) if meta.is_file() => meta,
            _ => continue,
        };
        record.source_id = new_id;
        record.source_inode = meta.ino();
        record.source_size = meta.len();
        record.source_modified_ns = source_modified_ns(&meta);
    }
    persist_cache_index(&state.config.cache, &index).await?;
    *state.cache_index.write().await = index;
    drop(_write);

    let updates = state
        .media_jobs
        .iter()
        .filter_map(|job| {
            remapped_source_id(&state.config, &job.source_id, source, target)
                .map(|new_id| (job.key.clone(), new_id))
        })
        .collect::<Vec<_>>();
    for (key, new_id) in updates {
        let file_name = state
            .config
            .root
            .join(decode_path(&new_id)?)
            .file_name()
            .unwrap_or_else(|| OsStr::new("video"))
            .to_string_lossy()
            .into_owned();
        emit_media_job(state, &key, |job| {
            job.source_id = new_id;
            job.file_name = file_name;
        });
    }
    Ok(())
}

async fn entry_from_path(state: &AppState, path: PathBuf) -> ApiResult<Entry> {
    let config = &state.config;
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
    let etag = metadata_etag(&meta);
    let id = encode_path(relative.as_os_str());
    let has_provenance = kind == "file"
        && state
            .provenance
            .read()
            .await
            .get(&id)
            .is_some_and(|urls| !urls.is_empty());
    let browser_ready = if kind == "file" && mime.starts_with("video/") {
        let key = find_cache_key(state, "hls", &id, &meta, None)
            .await
            .unwrap_or_else(|| hls_cache_key(&id, &meta));
        if playlist_state(&config.cache.join("hls").join(&key)).0 {
            true
        } else if let Some(ready) = state.direct_playable.get(&key) {
            *ready
        } else {
            let ready = probe_codec_info(&path)
                .await
                .as_ref()
                .is_some_and(browser_compatible_source);
            state.direct_playable.insert(key, ready);
            ready
        }
    } else {
        false
    };
    Ok(Entry {
        id,
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
        has_provenance,
        browser_ready,
        child_file_count: None,
        child_directory_count: None,
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

#[utoipa::path(get, path = "/api/v1/fs/content", tag = "filesystem", params(("id" = String, Query), ("Range" = Option<String>, Header)), security(("sessionCookie" = [])), responses((status = 200, description = "File download", content_type = "application/octet-stream"), (status = 206, description = "Partial file download", content_type = "application/octet-stream"), (status = 404, body = Problem)))]
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

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateRequest {
    parent_id: String,
    name: String,
    kind: String,
    #[serde(default)]
    replace: bool,
}

#[utoipa::path(post, path = "/api/v1/fs/items", tag = "filesystem", params(("x-csrf-token" = String, Header)), request_body = CreateRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 201, body = Entry), (status = 400, body = Problem), (status = 409, body = Problem)))]
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
        Json(entry_from_path(&state, path).await?),
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

#[utoipa::path(post, path = "/api/v1/fs/uploads", tag = "filesystem", params(("id" = String, Query), ("replace" = Option<bool>, Query), ("x-csrf-token" = String, Header)), request_body(content = String, content_type = "multipart/form-data", description = "One or more files fields"), security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 200, body = [Entry]), (status = 400, body = Problem), (status = 413, body = Problem)))]
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
            if let Err(error) = invalidate_cache_prefix(&state, &target).await {
                warn!(?error, path = %target.display(), "could not invalidate replaced cache");
            }
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
        uploaded.push(entry_from_path(&state, target).await?);
    }
    Ok(Json(uploaded))
}

#[derive(Deserialize, utoipa::ToSchema)]
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

#[utoipa::path(post, path = "/api/v1/fs/operations", tag = "filesystem", params(("x-csrf-token" = String, Header)), request_body = OperationRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 200, body = [Entry]), (status = 400, body = Problem), (status = 409, body = Problem)))]
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
                    if let Err(error) = remap_cache(&state, &source, &target).await {
                        warn!(?error, source = %source.display(), target = %target.display(), "could not remap cache after move");
                    }
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
        results.push(entry_from_path(&state, target).await?);
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
                            if let Err(error) = remap_cache(state, &source_item, &target_item).await
                            {
                                warn!(?error, source = %source_item.display(), target = %target_item.display(), "could not remap merged cache");
                            }
                        }
                        Ok(target_meta) => {
                            let source_meta = fs::symlink_metadata(&source_item).await?;
                            if source_meta.is_dir() && target_meta.is_dir() {
                                tasks.push(MergeTask::Merge(source_item, target_item));
                            } else {
                                move_to_trash(&state.config, &target_item).await?;
                                if let Err(error) =
                                    invalidate_cache_prefix(state, &target_item).await
                                {
                                    warn!(?error, path = %target_item.display(), "could not invalidate replaced cache");
                                }
                                if fs::rename(&source_item, &target_item).await.is_err() {
                                    copy_recursively(&source_item, &target_item).await?;
                                    remove_recursively(&source_item).await?;
                                }
                                remap_provenance(state, &source_item, &target_item, false).await?;
                                if let Err(error) =
                                    remap_cache(state, &source_item, &target_item).await
                                {
                                    warn!(?error, source = %source_item.display(), target = %target_item.display(), "could not remap merged cache");
                                }
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

#[derive(Deserialize, utoipa::ToSchema)]
struct DeleteRequest {
    ids: Vec<String>,
}

#[utoipa::path(post, path = "/api/v1/fs/trash", tag = "filesystem", params(("x-csrf-token" = String, Header)), request_body = DeleteRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 204), (status = 400, body = Problem)))]
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

#[derive(Serialize, Deserialize, utoipa::ToSchema)]
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

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct TrashEntry {
    info: TrashInfo,
    kind: String,
    size: u64,
}

#[utoipa::path(get, path = "/api/v1/trash", tag = "trash", security(("sessionCookie" = [])), responses((status = 200, body = [TrashEntry]), (status = 401, body = Problem)))]
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

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct RestoreRequest {
    destination_id: Option<String>,
    #[serde(default)]
    replace: bool,
}

#[utoipa::path(post, path = "/api/v1/trash/{id}/restore", tag = "trash", params(("id" = Uuid, Path), ("x-csrf-token" = String, Header)), request_body = RestoreRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 200, body = Entry), (status = 404, body = Problem), (status = 409, body = Problem)))]
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
    Ok(Json(entry_from_path(&state, target).await?))
}

#[utoipa::path(delete, path = "/api/v1/trash/{id}", tag = "trash", params(("id" = Uuid, Path), ("x-csrf-token" = String, Header)), security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 204), (status = 404, body = Problem)))]
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

#[utoipa::path(delete, path = "/api/v1/trash", tag = "trash", params(("x-csrf-token" = String, Header)), security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 204), (status = 401, body = Problem)))]
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

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct Document {
    id: String,
    content: String,
    etag: String,
    mime: String,
}

#[utoipa::path(get, path = "/api/v1/editor/document", tag = "editor", params(("id" = String, Query)), security(("sessionCookie" = [])), responses((status = 200, body = Document), (status = 400, body = Problem), (status = 404, body = Problem)))]
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

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct WriteDocument {
    id: String,
    content: String,
    expected_etag: String,
}

#[utoipa::path(put, path = "/api/v1/editor/document", tag = "editor", params(("x-csrf-token" = String, Header)), request_body = WriteDocument, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 200, body = Document), (status = 409, body = Problem), (status = 413, body = Problem)))]
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
#[serde(rename_all = "camelCase")]
struct ImageMarkupQuery {
    id: String,
    expected_etag: String,
}

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

fn metadata_etag(metadata: &std::fs::Metadata) -> String {
    format!(
        "\"{:x}-{:x}-{:x}\"",
        metadata.ino(),
        metadata.len(),
        metadata.mtime_nsec() ^ metadata.mtime()
    )
}

fn has_png_signature(signature: &[u8]) -> bool {
    signature.starts_with(PNG_SIGNATURE)
}

async fn publish_image_markup_file(temporary: &Path, source: &Path) -> ApiResult<PathBuf> {
    let directory = source
        .parent()
        .ok_or_else(|| ApiError::bad("invalid_path", "The source has no parent directory"))?;
    let mut base = source
        .file_stem()
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| OsStr::new("image"))
        .to_os_string();
    base.push("-markup");
    for suffix in 1..=10_000 {
        let mut name = base.clone();
        if suffix > 1 {
            name.push(format!("-{suffix}"));
        }
        name.push(".png");
        let target = directory.join(name);
        match fs::hard_link(temporary, &target).await {
            Ok(()) => {
                fs::remove_file(temporary).await?;
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(ApiError::conflict(
        "too_many_collisions",
        "Could not choose a unique markup filename",
    ))
}

#[utoipa::path(post, path = "/api/v1/editor/image-markup", tag = "editor", params(("id" = String, Query), ("expectedEtag" = String, Query), ("x-csrf-token" = String, Header)), request_body(content = String, content_type = "multipart/form-data", description = "PNG markup file field"), security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 201, body = Entry), (status = 400, body = Problem), (status = 409, body = Problem), (status = 413, body = Problem)))]
async fn save_image_markup(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(query): Query<ImageMarkupQuery>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<Entry>)> {
    require_csrf(&state, &jar, &headers)?;
    let source = resolve_existing(&state.config, &query.id).await?;
    let metadata = fs::symlink_metadata(&source).await?;
    let mime = mime_guess::from_path(&source).first_or_octet_stream();
    if !metadata.is_file() || mime.type_() != mime_guess::mime::IMAGE {
        return Err(ApiError::bad(
            "not_image",
            "The markup source is no longer a regular image",
        ));
    }
    if metadata_etag(&metadata) != query.expected_etag {
        return Err(ApiError::conflict(
            "image_changed",
            "The source image changed after markup began",
        ));
    }
    let directory = source
        .parent()
        .ok_or_else(|| ApiError::bad("invalid_path", "The source has no parent directory"))?;
    let temporary = directory.join(format!(".rfb-image-markup-{}.png", Uuid::new_v4()));
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await?;

    let write_result: ApiResult<()> = async {
        let mut field = multipart
            .next_field()
            .await
            .map_err(ApiError::internal)?
            .ok_or_else(|| ApiError::bad("missing_markup", "No markup PNG was supplied"))?;
        if field.name() != Some("file") {
            return Err(ApiError::bad(
                "missing_markup",
                "The markup upload must use the file field",
            ));
        }
        let mut written = 0u64;
        let mut signature = Vec::with_capacity(PNG_SIGNATURE.len());
        while let Some(chunk) = field.chunk().await.map_err(ApiError::internal)? {
            written += chunk.len() as u64;
            if written > state.config.upload_max {
                return Err(ApiError(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "markup_too_large",
                    "Markup exceeds the configured upload limit".into(),
                ));
            }
            if signature.len() < PNG_SIGNATURE.len() {
                let needed = PNG_SIGNATURE.len() - signature.len();
                signature.extend_from_slice(&chunk[..chunk.len().min(needed)]);
            }
            output.write_all(&chunk).await?;
        }
        if !has_png_signature(&signature) {
            return Err(ApiError::bad(
                "invalid_markup",
                "The markup upload is not a PNG image",
            ));
        }
        output.flush().await?;
        output.sync_all().await?;
        Ok(())
    }
    .await;
    drop(output);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary).await;
        return Err(error);
    }
    if let Err(error) = fs::set_permissions(
        &temporary,
        std::fs::Permissions::from_mode(metadata.mode() & 0o777),
    )
    .await
    {
        let _ = fs::remove_file(&temporary).await;
        return Err(error.into());
    }
    let target = match publish_image_markup_file(&temporary, &source).await {
        Ok(target) => target,
        Err(error) => {
            let _ = fs::remove_file(&temporary).await;
            return Err(error);
        }
    };
    Ok((
        StatusCode::CREATED,
        Json(entry_from_path(&state, target).await?),
    ))
}

#[derive(Deserialize)]
struct PreviewQuery {
    id: String,
    size: Option<String>,
}

fn thumbnail_cache_key(id: &str, meta: &std::fs::Metadata, dimension: u32) -> String {
    blake3::hash(
        format!(
            "{}:{}:{}:{}:{dimension}",
            id,
            meta.ino(),
            meta.len(),
            source_modified_ns(meta)
        )
        .as_bytes(),
    )
    .to_hex()
    .to_string()
}

#[utoipa::path(get, path = "/api/v1/previews/thumbnail", tag = "media", params(("id" = String, Query), ("size" = Option<String>, Query)), security(("sessionCookie" = [])), responses((status = 200, description = "WebP thumbnail", content_type = "image/webp"), (status = 400, body = Problem)))]
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
    let key = find_cache_key(&state, "thumbnail", &query.id, &meta, Some(dimension))
        .await
        .unwrap_or_else(|| thumbnail_cache_key(&query.id, &meta, dimension));
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
    register_cache_record(
        &state,
        CacheRecord {
            kind: "thumbnail".into(),
            key: key.clone(),
            source_id: query.id,
            source_inode: meta.ino(),
            source_size: meta.len(),
            source_modified_ns: source_modified_ns(&meta),
            dimension: Some(dimension),
        },
    )
    .await?;
    serve_file(output, &headers, true).await
}

#[utoipa::path(get, path = "/api/v1/media/file", tag = "media", params(("id" = String, Query), ("Range" = Option<String>, Header)), security(("sessionCookie" = [])), responses((status = 200, description = "Inline image, video, or audio"), (status = 206, description = "Partial media response"), (status = 400, body = Problem)))]
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

#[derive(Deserialize, utoipa::ToSchema)]
struct VfxProjectRequest {
    id: String,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct VfxProjectResponse {
    project_id: String,
    reused: bool,
}

#[derive(Deserialize)]
struct VfxProject {
    id: String,
}

#[derive(Deserialize)]
struct VfxProblem {
    error: Option<String>,
}

fn vfx_integration_key(id: &str, metadata: &std::fs::Metadata) -> String {
    let version = format!(
        "\"{:x}-{:x}-{:x}\"",
        metadata.ino(),
        metadata.len(),
        metadata.mtime_nsec() ^ metadata.mtime()
    );
    blake3::hash(format!("remote-file-browser\0{id}\0{version}").as_bytes())
        .to_hex()
        .to_string()
}

fn vfx_service_error(status: reqwest::StatusCode, problem: Option<VfxProblem>) -> ApiError {
    let message = problem
        .and_then(|value| value.error)
        .unwrap_or_else(|| "VFX Editor could not import the video".into());
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "vfx_source_too_large",
            message,
        )
    } else if status.is_client_error() {
        ApiError::bad("vfx_import_failed", message)
    } else {
        ApiError(StatusCode::BAD_GATEWAY, "vfx_service_failed", message)
    }
}

#[utoipa::path(post, path = "/api/v1/integrations/vfx/projects", tag = "media", params(("x-csrf-token" = String, Header)), request_body = VfxProjectRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 200, body = VfxProjectResponse), (status = 400, body = Problem), (status = 413, body = Problem), (status = 503, body = Problem)))]
async fn open_vfx_project(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(input): Json<VfxProjectRequest>,
) -> ApiResult<Json<VfxProjectResponse>> {
    require_csrf(&state, &jar, &headers)?;
    let api_url = state.config.vfx_editor_api_url.as_deref().ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "vfx_unavailable",
            "VFX Editor is not configured".into(),
        )
    })?;
    let path = resolve_existing(&state.config, &input.id).await?;
    let metadata = fs::symlink_metadata(&path).await?;
    if !metadata.is_file() {
        return Err(ApiError::bad("not_video", "Choose a regular video file"));
    }
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    if mime.type_() != mime_guess::mime::VIDEO {
        return Err(ApiError::bad("not_video", "Choose a video file"));
    }
    if metadata.len() > VFX_EDITOR_MAX_SOURCE_BYTES {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "vfx_source_too_large",
            "VFX Editor accepts source videos up to 40 GB".into(),
        ));
    }

    let integration_key = vfx_integration_key(&input.id, &metadata);
    let endpoint =
        format!("{api_url}/api/integrations/remote-file-browser/projects/{integration_key}");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(ApiError::internal)?;

    let lookup = client.get(&endpoint).send().await.map_err(|error| {
        warn!(%error, "VFX Editor lookup failed");
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "vfx_unavailable",
            "VFX Editor is unavailable".into(),
        )
    })?;
    if lookup.status().is_success() {
        let project: VfxProject = lookup.json().await.map_err(ApiError::internal)?;
        return Ok(Json(VfxProjectResponse {
            project_id: project.id,
            reused: true,
        }));
    }
    if lookup.status() != reqwest::StatusCode::NOT_FOUND {
        let status = lookup.status();
        let problem = lookup.json::<VfxProblem>().await.ok();
        return Err(vfx_service_error(status, problem));
    }

    let file = fs::File::open(&path).await?;
    let stream = ReaderStream::new(file);
    let filename = path
        .file_name()
        .unwrap_or_else(|| OsStr::new("video.media"))
        .to_string_lossy()
        .into_owned();
    let part = reqwest::multipart::Part::stream_with_length(
        reqwest::Body::wrap_stream(stream),
        metadata.len(),
    )
    .file_name(filename)
    .mime_str(mime.as_ref())
    .map_err(ApiError::internal)?;
    let response = client
        .post(&endpoint)
        .multipart(reqwest::multipart::Form::new().part("file", part))
        .send()
        .await
        .map_err(|error| {
            warn!(%error, "VFX Editor import failed");
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "vfx_unavailable",
                "VFX Editor is unavailable".into(),
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        let problem = response.json::<VfxProblem>().await.ok();
        return Err(vfx_service_error(status, problem));
    }
    let project: VfxProject = response.json().await.map_err(ApiError::internal)?;
    Ok(Json(VfxProjectResponse {
        project_id: project.id,
        reused: false,
    }))
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct VfxExportRequest {
    id: String,
    project_id: String,
}

#[derive(Serialize, utoipa::ToSchema)]
struct VfxExportResponse {
    id: String,
    name: String,
}

async fn publish_vfx_export_file(temporary: &Path, source: &Path) -> ApiResult<PathBuf> {
    let directory = source
        .parent()
        .ok_or_else(|| ApiError::bad("invalid_path", "The source has no parent directory"))?;
    let mut base = source
        .file_stem()
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| OsStr::new("video"))
        .to_os_string();
    base.push("-edited");
    for suffix in 1..=10_000 {
        let mut name = base.clone();
        if suffix > 1 {
            name.push(format!("-{suffix}"));
        }
        name.push(".mp4");
        let target = directory.join(name);
        match fs::hard_link(temporary, &target).await {
            Ok(()) => {
                fs::remove_file(temporary).await?;
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(ApiError::conflict(
        "too_many_collisions",
        "Could not choose a unique export filename",
    ))
}

#[utoipa::path(post, path = "/api/v1/integrations/vfx/exports", tag = "media", params(("x-csrf-token" = String, Header)), request_body = VfxExportRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 200, body = VfxExportResponse), (status = 400, body = Problem), (status = 401, body = Problem), (status = 403, body = Problem), (status = 409, body = Problem), (status = 502, body = Problem), (status = 503, body = Problem)))]
async fn save_vfx_export(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(input): Json<VfxExportRequest>,
) -> ApiResult<Json<VfxExportResponse>> {
    require_csrf(&state, &jar, &headers)?;
    let api_url = state.config.vfx_editor_api_url.as_deref().ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "vfx_unavailable",
            "VFX Editor is not configured".into(),
        )
    })?;
    let source = resolve_existing(&state.config, &input.id).await?;
    let metadata = fs::symlink_metadata(&source).await?;
    if !metadata.is_file() {
        return Err(ApiError::bad(
            "not_video",
            "The original source is no longer a regular file",
        ));
    }
    let integration_key = vfx_integration_key(&input.id, &metadata);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(ApiError::internal)?;
    let lookup_endpoint =
        format!("{api_url}/api/integrations/remote-file-browser/projects/{integration_key}");
    let lookup = client.get(lookup_endpoint).send().await.map_err(|error| {
        warn!(%error, "VFX Editor export validation failed");
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "vfx_unavailable",
            "VFX Editor is unavailable".into(),
        )
    })?;
    if !lookup.status().is_success() {
        return Err(ApiError::conflict(
            "vfx_source_changed",
            "The original video changed after it was opened in VFX Editor",
        ));
    }
    let project: VfxProject = lookup.json().await.map_err(ApiError::internal)?;
    if project.id != input.project_id {
        return Err(ApiError::forbidden(
            "vfx_project_mismatch",
            "The VFX project does not belong to this source video",
        ));
    }

    let response = client
        .get(format!(
            "{api_url}/api/projects/{}/media/export",
            input.project_id
        ))
        .send()
        .await
        .map_err(|error| {
            warn!(%error, "VFX Editor export download failed");
            ApiError(
                StatusCode::BAD_GATEWAY,
                "vfx_export_failed",
                "Could not retrieve the completed VFX export".into(),
            )
        })?;
    if !response.status().is_success() {
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            "vfx_export_failed",
            "The completed VFX export is unavailable".into(),
        ));
    }

    let directory = source
        .parent()
        .ok_or_else(|| ApiError::bad("invalid_path", "The source has no parent directory"))?;
    let temporary = directory.join(format!(".rfb-vfx-export-{}.mp4", Uuid::new_v4()));
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await?;
    let write_result: ApiResult<()> = async {
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                warn!(%error, "VFX Editor export stream failed");
                ApiError(
                    StatusCode::BAD_GATEWAY,
                    "vfx_export_failed",
                    "The VFX export stream was interrupted".into(),
                )
            })?;
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        output.sync_all().await?;
        Ok(())
    }
    .await;
    drop(output);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary).await;
        return Err(error);
    }
    if let Err(error) = fs::set_permissions(
        &temporary,
        std::fs::Permissions::from_mode(metadata.mode() & 0o777),
    )
    .await
    {
        let _ = fs::remove_file(&temporary).await;
        return Err(error.into());
    }
    let target = match publish_vfx_export_file(&temporary, &source).await {
        Ok(target) => target,
        Err(error) => {
            let _ = fs::remove_file(&temporary).await;
            return Err(error);
        }
    };
    let relative = target
        .strip_prefix(&state.config.root)
        .map_err(ApiError::internal)?;
    Ok(Json(VfxExportResponse {
        id: encode_path(relative.as_os_str()),
        name: target
            .file_name()
            .unwrap_or_else(|| OsStr::new("export.mp4"))
            .to_string_lossy()
            .into_owned(),
    }))
}

#[derive(Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct MediaInfo {
    duration_seconds: f64,
    frame_rate: Option<f64>,
}

#[derive(Deserialize)]
struct MediaProbeOutput {
    streams: Vec<MediaProbeStream>,
    format: MediaProbeFormat,
}

#[derive(Deserialize)]
struct MediaProbeStream {
    codec_type: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
}

#[derive(Deserialize)]
struct MediaProbeFormat {
    duration: Option<String>,
}

fn parse_frame_rate(value: &str) -> Option<f64> {
    let (numerator, denominator) = value.split_once('/')?;
    let numerator = numerator.parse::<f64>().ok()?;
    let denominator = denominator.parse::<f64>().ok()?;
    let rate = numerator / denominator;
    (rate.is_finite() && rate > 0.0).then_some(rate)
}

async fn probe_media(source: &Path) -> ApiResult<MediaInfo> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,avg_frame_rate,r_frame_rate:format=duration",
            "-of",
            "json",
        ])
        .arg(source)
        .output()
        .await
        .map_err(ApiError::internal)?;
    if !output.status.success() {
        return Err(ApiError::bad(
            "not_video",
            "FFprobe could not read this video",
        ));
    }
    let probe: MediaProbeOutput =
        serde_json::from_slice(&output.stdout).map_err(ApiError::internal)?;
    let video = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| ApiError::bad("not_video", "The selected file has no video stream"))?;
    let duration_seconds = probe
        .format
        .duration
        .as_deref()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| ApiError::bad("invalid_duration", "The video duration is unavailable"))?;
    let frame_rate = video
        .avg_frame_rate
        .as_deref()
        .and_then(parse_frame_rate)
        .or_else(|| video.r_frame_rate.as_deref().and_then(parse_frame_rate));
    Ok(MediaInfo {
        duration_seconds,
        frame_rate,
    })
}

#[utoipa::path(get, path = "/api/v1/media/info", tag = "media", params(("id" = String, Query)), security(("sessionCookie" = [])), responses((status = 200, body = MediaInfo), (status = 400, body = Problem)))]
async fn media_info(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<IdQuery>,
) -> ApiResult<Json<MediaInfo>> {
    require_session(&state, &jar)?;
    let source = resolve_existing(&state.config, &query.id).await?;
    if !fs::metadata(&source).await?.is_file() {
        return Err(ApiError::bad(
            "not_file",
            "Video source must be a regular file",
        ));
    }
    Ok(Json(probe_media(&source).await?))
}

#[derive(Clone, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ExtractionRequest {
    id: String,
    kind: String,
    time: Option<f64>,
    start_time: Option<f64>,
    end_time: Option<f64>,
}

#[derive(Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ExtractionJob {
    key: String,
    file_name: String,
    kind: String,
    status: String,
    time: Option<f64>,
    start_time: Option<f64>,
    end_time: Option<f64>,
    started_at: DateTime<Utc>,
    progress: Option<f64>,
    error: Option<String>,
    result: Option<Entry>,
}

fn valid_media_time(value: f64, duration: f64) -> bool {
    value.is_finite() && value >= 0.0 && value < duration
}

fn timestamp_label(seconds: f64) -> String {
    let millis = (seconds.max(0.0) * 1000.0).round() as u64;
    format!(
        "{:02}-{:02}-{:02}.{:03}",
        millis / 3_600_000,
        millis / 60_000 % 60,
        millis / 1000 % 60,
        millis % 1000
    )
}

fn frame_extraction_command(source: &Path, target: &Path, time: f64) -> Command {
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-ss",
        ])
        .arg(format!("{time:.6}"))
        .args(["-accurate_seek", "-i"])
        .arg(source)
        .args(["-map", "0:v:0", "-frames:v", "1", "-y"])
        .arg(target);
    command
}

async fn publish_extraction(
    temporary: &Path,
    directory: &Path,
    base: &str,
    extension: &str,
) -> ApiResult<PathBuf> {
    for suffix in 1..=10_000 {
        let name = if suffix == 1 {
            format!("{base}.{extension}")
        } else {
            format!("{base}-{suffix}.{extension}")
        };
        let target = directory.join(name);
        match fs::hard_link(temporary, &target).await {
            Ok(()) => {
                fs::remove_file(temporary).await?;
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(ApiError::conflict(
        "too_many_collisions",
        "Could not choose a unique extraction filename",
    ))
}

async fn run_extraction(
    state: &AppState,
    key: &str,
    request: &ExtractionRequest,
    source: &Path,
) -> ApiResult<Entry> {
    let directory = source
        .parent()
        .ok_or_else(|| ApiError::bad("invalid_path", "Video has no parent directory"))?;
    let stem = source
        .file_stem()
        .unwrap_or_else(|| OsStr::new("video"))
        .to_string_lossy();
    let (base, extension, temporary, mut command) = if request.kind == "frame" {
        let time = request.time.unwrap();
        let base = format!("{stem}-frame-{}", timestamp_label(time));
        let temporary = directory.join(format!(".rfb-extraction-{}.png", Uuid::new_v4()));
        let command = frame_extraction_command(source, &temporary, time);
        (base, "png", temporary, command)
    } else {
        let start = request.start_time.unwrap();
        let end = request.end_time.unwrap();
        let base = format!(
            "{stem}-clip-{}-to-{}",
            timestamp_label(start),
            timestamp_label(end)
        );
        let temporary = directory.join(format!(".rfb-extraction-{}.mp4", Uuid::new_v4()));
        let mut command = Command::new("ffmpeg");
        command
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
                "-i",
            ])
            .arg(source)
            .args([
                "-ss",
                &format!("{start:.6}"),
                "-t",
                &format!("{:.6}", end - start),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-sn",
                "-dn",
                "-vf",
                "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-y",
            ])
            .arg(&temporary);
        (base, "mp4", temporary, command)
    };
    let output = match command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            let progress = if request.kind == "segment" {
                child.stdout.take().map(|stdout| {
                    tokio::spawn(track_extraction_progress(
                        stdout,
                        state.clone(),
                        key.to_owned(),
                        request.end_time.unwrap() - request.start_time.unwrap(),
                    ))
                })
            } else {
                None
            };
            let output = child.wait_with_output().await;
            if let Some(progress) = progress {
                let _ = progress.await;
            }
            output.map_err(ApiError::internal)?
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary).await;
            return Err(ApiError::internal(error));
        }
    };
    if !output.status.success() {
        let _ = fs::remove_file(&temporary).await;
        let detail = String::from_utf8_lossy(&output.stderr);
        error!(kind = %request.kind, source = %source.display(), %detail, "media extraction failed");
        return Err(ApiError::bad(
            "extraction_failed",
            "FFmpeg could not extract the media",
        ));
    }
    let target = match publish_extraction(&temporary, directory, &base, extension).await {
        Ok(target) => target,
        Err(error) => {
            let _ = fs::remove_file(&temporary).await;
            return Err(error);
        }
    };
    entry_from_path(state, target).await
}

#[utoipa::path(post, path = "/api/v1/media/extractions", tag = "media", params(("x-csrf-token" = String, Header)), request_body = ExtractionRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 202, body = ExtractionJob), (status = 400, body = Problem)))]
async fn start_extraction(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<ExtractionRequest>,
) -> ApiResult<(StatusCode, Json<ExtractionJob>)> {
    require_csrf(&state, &jar, &headers)?;
    let source = resolve_existing(&state.config, &request.id).await?;
    if !fs::metadata(&source).await?.is_file() {
        return Err(ApiError::bad(
            "not_file",
            "Video source must be a regular file",
        ));
    }
    let info = probe_media(&source).await?;
    match request.kind.as_str() {
        "frame"
            if request
                .time
                .is_some_and(|time| valid_media_time(time, info.duration_seconds)) => {}
        "segment"
            if request
                .start_time
                .is_some_and(|time| valid_media_time(time, info.duration_seconds))
                && request.end_time.is_some_and(|time| {
                    time.is_finite() && time > 0.0 && time <= info.duration_seconds
                })
                && request.end_time.unwrap() > request.start_time.unwrap() => {}
        "frame" | "segment" => {
            return Err(ApiError::bad(
                "invalid_time",
                "Extraction timestamps are outside the video",
            ));
        }
        _ => {
            return Err(ApiError::bad(
                "invalid_kind",
                "Extraction kind must be frame or segment",
            ));
        }
    }
    let key = Uuid::new_v4().simple().to_string();
    let job = ExtractionJob {
        key: key.clone(),
        file_name: source
            .file_name()
            .unwrap_or_else(|| OsStr::new("video"))
            .to_string_lossy()
            .into_owned(),
        kind: request.kind.clone(),
        status: "working".into(),
        time: request.time,
        start_time: request.start_time,
        end_time: request.end_time,
        started_at: Utc::now(),
        progress: (request.kind == "segment").then_some(0.0),
        error: None,
        result: None,
    };
    state.extraction_jobs.insert(key.clone(), job.clone());
    let _ = state.live_events.send(LiveEvent::ExtractionJob {
        job: Box::new(job.clone()),
    });
    if state.extraction_jobs.len() > 100 {
        let mut oldest = state
            .extraction_jobs
            .iter()
            .filter(|candidate| candidate.status != "working")
            .map(|candidate| (candidate.started_at, candidate.key.clone()))
            .collect::<Vec<_>>();
        oldest.sort_by_key(|candidate| candidate.0);
        for (_, old_key) in oldest
            .into_iter()
            .take(state.extraction_jobs.len().saturating_sub(100))
        {
            state.extraction_jobs.remove(&old_key);
        }
    }
    let task_state = state.clone();
    tokio::spawn(async move {
        let outcome = run_extraction(&task_state, &key, &request, &source).await;
        emit_extraction_job(&task_state, &key, |job| match outcome {
            Ok(entry) => {
                job.status = "ready".into();
                job.progress = (job.kind == "segment").then_some(1.0);
                job.result = Some(entry);
            }
            Err(error) => {
                job.status = "failed".into();
                job.error = Some(error.2);
            }
        });
    });
    Ok((StatusCode::ACCEPTED, Json(job)))
}

#[utoipa::path(get, path = "/api/v1/media/extractions", tag = "media", security(("sessionCookie" = [])), responses((status = 200, body = [ExtractionJob])))]
async fn list_extraction_jobs(
    State(state): State<AppState>,
    jar: CookieJar,
) -> ApiResult<Json<Vec<ExtractionJob>>> {
    require_session(&state, &jar)?;
    let mut jobs = state
        .extraction_jobs
        .iter()
        .map(|job| job.value().clone())
        .collect::<Vec<_>>();
    jobs.sort_by_key(|job| std::cmp::Reverse(job.started_at));
    jobs.truncate(20);
    Ok(Json(jobs))
}

#[utoipa::path(get, path = "/api/v1/media/extractions/{key}", tag = "media", params(("key" = String, Path)), security(("sessionCookie" = [])), responses((status = 200, body = ExtractionJob), (status = 404, body = Problem)))]
async fn extraction_status(
    State(state): State<AppState>,
    jar: CookieJar,
    AxumPath(key): AxumPath<String>,
) -> ApiResult<Json<ExtractionJob>> {
    require_session(&state, &jar)?;
    let job = state
        .extraction_jobs
        .get(&key)
        .map(|job| job.value().clone())
        .ok_or_else(|| ApiError::not_found("Extraction job does not exist"))?;
    Ok(Json(job))
}

#[derive(Clone, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ConcatenationRequest {
    ids: Vec<String>,
    output_name: String,
}

#[derive(Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ConcatenationJob {
    key: String,
    file_name: String,
    status: String,
    started_at: DateTime<Utc>,
    progress: Option<f64>,
    error: Option<String>,
    result: Option<Entry>,
}

fn valid_concat_output_name(name: &str) -> bool {
    let path = Path::new(name);
    !name.is_empty()
        && name.len() <= 255
        && path.components().count() == 1
        && path
            .file_name()
            .is_some_and(|value| value == OsStr::new(name))
        && name.to_ascii_lowercase().ends_with(".mp4")
        && path.file_stem().is_some_and(|stem| !stem.is_empty())
}

fn concat_list_line(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('\'', "'\\\\''");
    format!("file '{escaped}'\\n")
}

fn concat_compatible(left: &ProbeOutput, right: &ProbeOutput) -> bool {
    left.streams == right.streams
}

async fn run_concatenation(
    state: &AppState,
    key: &str,
    sources: Vec<PathBuf>,
    output_name: &str,
    duration: f64,
) -> ApiResult<Entry> {
    let directory = sources
        .first()
        .and_then(|source| source.parent())
        .ok_or_else(|| ApiError::bad("invalid_path", "Video has no parent directory"))?;
    let list = directory.join(format!(".rfb-concat-{key}.txt"));
    let temporary = directory.join(format!(".rfb-concat-{key}.mp4"));
    fs::write(
        &list,
        sources
            .iter()
            .map(|source| concat_list_line(source))
            .collect::<String>(),
    )
    .await?;
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-f",
            "concat",
            "-safe",
            "0",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(&list)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-y",
        ])
        .arg(&temporary);
    let output = match command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            let progress = child.stdout.take().map(|stdout| {
                tokio::spawn(track_concatenation_progress(
                    stdout,
                    state.clone(),
                    key.to_owned(),
                    duration,
                ))
            });
            let output = child.wait_with_output().await.map_err(ApiError::internal)?;
            if let Some(progress) = progress {
                let _ = progress.await;
            }
            output
        }
        Err(error) => {
            let _ = fs::remove_file(&list).await;
            return Err(ApiError::internal(error));
        }
    };
    let _ = fs::remove_file(&list).await;
    if !output.status.success() {
        let _ = fs::remove_file(&temporary).await;
        error!(detail = %String::from_utf8_lossy(&output.stderr), "video concatenation failed");
        return Err(ApiError::bad(
            "concatenation_failed",
            "FFmpeg could not concatenate the videos",
        ));
    }
    let base = Path::new(output_name)
        .file_stem()
        .unwrap()
        .to_string_lossy();
    let target = match publish_extraction(&temporary, directory, &base, "mp4").await {
        Ok(target) => target,
        Err(error) => {
            let _ = fs::remove_file(&temporary).await;
            return Err(error);
        }
    };
    entry_from_path(state, target).await
}

#[utoipa::path(post, path = "/api/v1/media/concatenations", tag = "media", params(("x-csrf-token" = String, Header)), request_body = ConcatenationRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 202, body = ConcatenationJob), (status = 400, body = Problem)))]
async fn start_concatenation(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(request): Json<ConcatenationRequest>,
) -> ApiResult<(StatusCode, Json<ConcatenationJob>)> {
    require_csrf(&state, &jar, &headers)?;
    if request.ids.len() < 2
        || request.ids.len() > 100
        || request.ids.iter().collect::<HashSet<_>>().len() != request.ids.len()
    {
        return Err(ApiError::bad(
            "invalid_sources",
            "Select between two and 100 unique video files",
        ));
    }
    if !valid_concat_output_name(&request.output_name) {
        return Err(ApiError::bad(
            "invalid_output_name",
            "Choose a single .mp4 filename",
        ));
    }
    let mut sources = Vec::with_capacity(request.ids.len());
    let mut total_duration = 0.0;
    let mut first_probe = None;
    let mut parent = None;
    for id in &request.ids {
        let source = resolve_existing(&state.config, id).await?;
        if !fs::metadata(&source).await?.is_file() {
            return Err(ApiError::bad(
                "not_file",
                "All selected items must be regular video files",
            ));
        }
        let probe = probe_codec_info(&source)
            .await
            .ok_or_else(|| ApiError::bad("not_video", "FFprobe could not read a selected video"))?;
        if !probe
            .streams
            .iter()
            .any(|stream| stream.codec_type.as_deref() == Some("video"))
        {
            return Err(ApiError::bad(
                "not_video",
                "All selected items must contain a video stream",
            ));
        }
        if let Some(first) = &first_probe {
            if !concat_compatible(first, &probe) {
                return Err(ApiError::bad(
                    "incompatible_videos",
                    "Selected videos must have compatible streams",
                ));
            }
        } else {
            first_probe = Some(probe);
        }
        let source_parent = source.parent().map(Path::to_path_buf);
        if parent.is_some() && parent != source_parent {
            return Err(ApiError::bad(
                "different_directories",
                "Selected videos must be in the same folder",
            ));
        }
        parent = source_parent;
        total_duration += probe_media(&source).await?.duration_seconds;
        sources.push(source);
    }
    let key = Uuid::new_v4().simple().to_string();
    let job = ConcatenationJob {
        key: key.clone(),
        file_name: request.output_name.clone(),
        status: "working".into(),
        started_at: Utc::now(),
        progress: Some(0.0),
        error: None,
        result: None,
    };
    state.concatenation_jobs.insert(key.clone(), job.clone());
    if state.concatenation_jobs.len() > 100 {
        let mut oldest = state
            .concatenation_jobs
            .iter()
            .filter(|candidate| candidate.status != "working")
            .map(|candidate| (candidate.started_at, candidate.key.clone()))
            .collect::<Vec<_>>();
        oldest.sort_by_key(|candidate| candidate.0);
        for (_, old_key) in oldest
            .into_iter()
            .take(state.concatenation_jobs.len().saturating_sub(100))
        {
            state.concatenation_jobs.remove(&old_key);
        }
    }
    let _ = state.live_events.send(LiveEvent::ConcatenationJob {
        job: Box::new(job.clone()),
    });
    let task_state = state.clone();
    tokio::spawn(async move {
        let outcome = run_concatenation(
            &task_state,
            &key,
            sources,
            &request.output_name,
            total_duration,
        )
        .await;
        emit_concatenation_job(&task_state, &key, |job| match outcome {
            Ok(entry) => {
                job.status = "ready".into();
                job.progress = Some(1.0);
                job.result = Some(entry);
            }
            Err(error) => {
                job.status = "failed".into();
                job.error = Some(error.2);
            }
        });
    });
    Ok((StatusCode::ACCEPTED, Json(job)))
}

#[utoipa::path(get, path = "/api/v1/media/concatenations", tag = "media", security(("sessionCookie" = [])), responses((status = 200, body = [ConcatenationJob])))]
async fn list_concatenation_jobs(
    State(state): State<AppState>,
    jar: CookieJar,
) -> ApiResult<Json<Vec<ConcatenationJob>>> {
    require_session(&state, &jar)?;
    let mut jobs = state
        .concatenation_jobs
        .iter()
        .map(|job| job.value().clone())
        .collect::<Vec<_>>();
    jobs.sort_by_key(|job| std::cmp::Reverse(job.started_at));
    jobs.truncate(20);
    Ok(Json(jobs))
}

#[derive(Deserialize, utoipa::ToSchema)]
struct HlsRequest {
    id: String,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct HlsResponse {
    key: String,
    status: String,
    playlist_url: String,
    playable: bool,
    mode: String,
}

#[derive(Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct MediaJob {
    key: String,
    file_name: String,
    status: String,
    playable: bool,
    mode: String,
    started_at: DateTime<Utc>,
    progress: Option<f64>,
    #[serde(skip)]
    #[schema(ignore)]
    source_id: String,
}

fn emit_media_job(state: &AppState, key: &str, update: impl FnOnce(&mut MediaJob)) {
    let job = state.media_jobs.get_mut(key).map(|mut job| {
        update(&mut job);
        job.clone()
    });
    if let Some(job) = job {
        let _ = state
            .live_events
            .send(LiveEvent::MediaJob { job: Box::new(job) });
    }
}

fn emit_extraction_job(state: &AppState, key: &str, update: impl FnOnce(&mut ExtractionJob)) {
    let job = state.extraction_jobs.get_mut(key).map(|mut job| {
        update(&mut job);
        job.clone()
    });
    if let Some(job) = job {
        let _ = state
            .live_events
            .send(LiveEvent::ExtractionJob { job: Box::new(job) });
    }
}

fn emit_concatenation_job(state: &AppState, key: &str, update: impl FnOnce(&mut ConcatenationJob)) {
    let job = state.concatenation_jobs.get_mut(key).map(|mut job| {
        update(&mut job);
        job.clone()
    });
    if let Some(job) = job {
        let _ = state
            .live_events
            .send(LiveEvent::ConcatenationJob { job: Box::new(job) });
    }
}

fn ffmpeg_progress_seconds(line: &str) -> Option<f64> {
    let value = line.strip_prefix("out_time_us=")?.parse::<f64>().ok()? / 1_000_000.0;
    (value.is_finite() && value >= 0.0).then_some(value)
}

async fn track_media_progress(
    reader: tokio::process::ChildStdout,
    state: AppState,
    key: String,
    duration: f64,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some(seconds) = ffmpeg_progress_seconds(&line) else {
            continue;
        };
        let progress = (seconds / duration).clamp(0.0, 0.995);
        let should_emit = state
            .media_jobs
            .get(&key)
            .and_then(|job| job.progress)
            .is_none_or(|previous| progress >= previous + 0.002);
        if should_emit {
            emit_media_job(&state, &key, |job| {
                job.progress = Some(progress.max(job.progress.unwrap_or(0.0)))
            });
        }
    }
}

async fn track_extraction_progress(
    reader: tokio::process::ChildStdout,
    state: AppState,
    key: String,
    duration: f64,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some(seconds) = ffmpeg_progress_seconds(&line) else {
            continue;
        };
        let progress = (seconds / duration).clamp(0.0, 0.995);
        let should_emit = state
            .extraction_jobs
            .get(&key)
            .and_then(|job| job.progress)
            .is_some_and(|previous| progress >= previous + 0.002);
        if should_emit {
            emit_extraction_job(&state, &key, |job| {
                job.progress = Some(progress.max(job.progress.unwrap_or(0.0)))
            });
        }
    }
}

async fn track_concatenation_progress(
    reader: tokio::process::ChildStdout,
    state: AppState,
    key: String,
    duration: f64,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some(seconds) = ffmpeg_progress_seconds(&line) else {
            continue;
        };
        let progress = (seconds / duration).clamp(0.0, 0.995);
        let should_emit = state
            .concatenation_jobs
            .get(&key)
            .and_then(|job| job.progress)
            .is_none_or(|previous| progress >= previous + 0.002);
        if should_emit {
            emit_concatenation_job(&state, &key, |job| {
                job.progress = Some(progress.max(job.progress.unwrap_or(0.0)));
            });
        }
    }
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
    format: Option<ProbeFormat>,
}

#[derive(Deserialize, PartialEq, Eq)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    pix_fmt: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    time_base: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    format_name: Option<String>,
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

fn browser_compatible_source(probe: &ProbeOutput) -> bool {
    let formats = probe
        .format
        .as_ref()
        .and_then(|format| format.format_name.as_deref())
        .unwrap_or_default()
        .split(',')
        .collect::<Vec<_>>();
    let video = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"));
    let audio = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"));
    let Some(video) = video else {
        return false;
    };
    if formats
        .iter()
        .any(|format| matches!(*format, "mov" | "mp4" | "m4a" | "3gp" | "3g2" | "mj2"))
    {
        return video.codec_name.as_deref() == Some("h264")
            && matches!(video.pix_fmt.as_deref(), Some("yuv420p") | Some("yuvj420p"))
            && audio.is_none_or(|stream| stream.codec_name.as_deref() == Some("aac"));
    }
    if formats.contains(&"webm") {
        return matches!(
            video.codec_name.as_deref(),
            Some("vp8") | Some("vp9") | Some("av1")
        ) && audio.is_none_or(|stream| {
            matches!(stream.codec_name.as_deref(), Some("opus") | Some("vorbis"))
        });
    }
    false
}

async fn probe_codec_info(source: &Path) -> Option<ProbeOutput> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=format_name:stream=codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,time_base,sample_rate,channels,channel_layout",
            "-of",
            "json",
        ])
        .arg(source)
        .output()
        .await;
    match output {
        Ok(output) if output.status.success() => serde_json::from_slice(&output.stdout).ok(),
        _ => None,
    }
}

async fn probe_conversion_mode(source: &Path) -> ConversionMode {
    probe_codec_info(source)
        .await
        .as_ref()
        .map(conversion_mode)
        .unwrap_or(ConversionMode::Full)
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

const HLS_CACHE_VERSION: &str = "ffmpeg-8.1.2-progressive-hls-v2";

fn hls_cache_key(id: &str, source_meta: &std::fs::Metadata) -> String {
    let fingerprint = format!(
        "{}:{}:{}:{:?}:{}",
        id,
        source_meta.ino(),
        source_meta.len(),
        source_meta.modified().ok(),
        HLS_CACHE_VERSION
    );
    blake3::hash(fingerprint.as_bytes()).to_hex().to_string()
}

#[cfg(test)]
fn hls_cache_directory(cache: &Path, id: &str, source_meta: &std::fs::Metadata) -> PathBuf {
    cache.join("hls").join(hls_cache_key(id, source_meta))
}

fn cached_mode(directory: &Path) -> String {
    std::fs::read_to_string(directory.join("mode"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| matches!(value.as_str(), "remux" | "audio" | "full"))
        .unwrap_or_else(|| "full".into())
}

#[utoipa::path(get, path = "/api/v1/media/jobs", tag = "media", security(("sessionCookie" = [])), responses((status = 200, body = [MediaJob]), (status = 401, body = Problem)))]
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
    jobs.sort_by_key(|job| std::cmp::Reverse(job.started_at));
    jobs.truncate(20);
    Ok(Json(jobs))
}

#[utoipa::path(post, path = "/api/v1/media/hls", tag = "media", params(("x-csrf-token" = String, Header)), request_body = HlsRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 200, body = HlsResponse), (status = 202, body = HlsResponse), (status = 400, body = Problem)))]
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
    let key = find_cache_key(&state, "hls", &input.id, &source_meta, None)
        .await
        .unwrap_or_else(|| hls_cache_key(&input.id, &source_meta));
    let directory = state.config.cache.join("hls").join(&key);
    let playlist = directory.join("index.m3u8");
    let file_name = source
        .file_name()
        .unwrap_or_else(|| OsStr::new("video"))
        .to_string_lossy()
        .into_owned();
    let (cached_playable, cached_ready) = playlist_state(&directory);
    if cached_ready {
        register_cache_record(
            &state,
            CacheRecord {
                kind: "hls".into(),
                key: key.clone(),
                source_id: input.id.clone(),
                source_inode: source_meta.ino(),
                source_size: source_meta.len(),
                source_modified_ns: source_modified_ns(&source_meta),
                dimension: None,
            },
        )
        .await?;
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
                progress: Some(1.0),
                source_id: input.id.clone(),
            },
        );
        if let Some(job) = state.media_jobs.get(&key).map(|job| job.value().clone()) {
            let _ = state
                .live_events
                .send(LiveEvent::MediaJob { job: Box::new(job) });
        }
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
        let duration = probe_media(&source).await?.duration_seconds;
        state.media_jobs.remove(&key);
        if fs::metadata(&directory).await.is_ok() {
            fs::remove_dir_all(&directory).await?;
        }
        fs::create_dir_all(&directory).await?;
        register_cache_record(
            &state,
            CacheRecord {
                kind: "hls".into(),
                key: key.clone(),
                source_id: input.id.clone(),
                source_inode: source_meta.ino(),
                source_size: source_meta.len(),
                source_modified_ns: source_modified_ns(&source_meta),
                dimension: None,
            },
        )
        .await?;
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
                progress: Some(0.0),
                source_id: input.id.clone(),
            },
        );
        if let Some(job) = state.media_jobs.get(&key).map(|job| job.value().clone()) {
            let _ = state
                .live_events
                .send(LiveEvent::MediaJob { job: Box::new(job) });
        }
        let task_state = state.clone();
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
                    "-progress",
                    "pipe:1",
                    "-nostats",
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
            let child = command.stdout(Stdio::piped()).spawn();
            let status = match child {
                Ok(mut child) => {
                    let progress = child.stdout.take().map(|stdout| {
                        tokio::spawn(track_media_progress(
                            stdout,
                            task_state.clone(),
                            job_key.clone(),
                            duration,
                        ))
                    });
                    let status = loop {
                        match child.try_wait() {
                            Ok(Some(status)) => break Some(status),
                            Ok(None) => {
                                let (playable, _) = playlist_state(&directory);
                                let became_playable = playable
                                    && task_state
                                        .media_jobs
                                        .get(&job_key)
                                        .is_some_and(|job| !job.playable);
                                if became_playable {
                                    emit_media_job(&task_state, &job_key, |job| {
                                        job.playable = true
                                    });
                                }
                                tokio::time::sleep(Duration::from_millis(500)).await;
                            }
                            Err(_) => break None,
                        }
                    };
                    if let Some(progress) = progress {
                        let _ = progress.await;
                    }
                    status
                }
                Err(_) => None,
            };
            let (playable, ready) = playlist_state(&directory);
            emit_media_job(&task_state, &job_key, |job| {
                job.playable = playable;
                if status.map(|s| s.success()).unwrap_or(false) && ready {
                    job.status = "ready".into();
                    job.progress = Some(1.0);
                } else {
                    job.status = "failed".into();
                }
            });
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

#[utoipa::path(get, path = "/api/v1/media/hls/{key}/status", tag = "media", params(("key" = String, Path)), security(("sessionCookie" = [])), responses((status = 200, body = HlsResponse), (status = 400, body = Problem)))]
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

#[utoipa::path(get, path = "/api/v1/media/hls/{key}/{file}", tag = "media", params(("key" = String, Path), ("file" = String, Path)), security(("sessionCookie" = [])), responses((status = 200, description = "HLS playlist or MPEG-TS segment"), (status = 206, description = "Partial HLS asset"), (status = 400, body = Problem)))]
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
            let _ = state.live_events.send(LiveEvent::CacheCleanup {
                state: "started".into(),
                report: None,
                error: None,
            });
            match cleanup_cache(&state).await {
                Ok(report) => {
                    let _ = state.live_events.send(LiveEvent::CacheCleanup {
                        state: "complete".into(),
                        report: Some(report),
                        error: None,
                    });
                }
                Err(error) => {
                    error!(?error, "cache cleanup failed");
                    let _ = state.live_events.send(LiveEvent::CacheCleanup {
                        state: "failed".into(),
                        report: None,
                        error: Some(error.2),
                    });
                }
            }
            tokio::time::sleep(Duration::from_secs(60 * 60)).await;
        }
    });
}

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

fn remove_artifact(path: &Path, directory: bool) -> std::io::Result<()> {
    if directory {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

async fn reconcile_cache(
    state: &AppState,
    active: &HashSet<String>,
) -> ApiResult<CacheCleanupReport> {
    let root = state.config.root.clone();
    let cache = state.config.cache.clone();
    let index = state.cache_index.read().await.clone();
    let active = active.clone();
    let (index, report) = tokio::task::spawn_blocking(move || {
        let mut index = index;
        let mut report = CacheCleanupReport::default();
        let stale = index
            .records
            .iter()
            .filter_map(|(record_id, record)| {
                let active_record = record.kind == "hls" && active.contains(&record.key);
                if active_record {
                    return None;
                }
                let artifact = cache_artifact_path(&cache, record);
                let source = decode_path(&record.source_id)
                    .ok()
                    .map(|path| root.join(path));
                let source_valid = source
                    .and_then(|path| std::fs::metadata(path).ok())
                    .is_some_and(|meta| {
                        meta.is_file()
                            && meta.ino() == record.source_inode
                            && meta.len() == record.source_size
                            && source_modified_ns(&meta) == record.source_modified_ns
                    });
                let artifact_valid =
                    artifact.exists() && (record.kind != "hls" || playlist_state(&artifact).1);
                (!source_valid || !artifact_valid).then_some((record_id.clone(), record.clone()))
            })
            .collect::<Vec<_>>();
        for (record_id, record) in stale {
            let artifact = cache_artifact_path(&cache, &record);
            if artifact.exists() {
                let bytes = if record.kind == "hls" {
                    directory_stats(&artifact).0
                } else {
                    std::fs::metadata(&artifact)
                        .map(|meta| meta.len())
                        .unwrap_or(0)
                };
                if remove_artifact(&artifact, record.kind == "hls").is_ok() {
                    report.artifacts_removed += 1;
                    report.bytes_reclaimed += bytes;
                }
            }
            index.records.remove(&record_id);
            report.records_removed += 1;
        }
        let referenced_hls = index
            .records
            .values()
            .filter(|record| record.kind == "hls")
            .map(|record| record.key.clone())
            .collect::<HashSet<_>>();
        let referenced_thumbnails = index
            .records
            .values()
            .filter(|record| record.kind == "thumbnail")
            .map(|record| format!("{}.webp", record.key))
            .collect::<HashSet<_>>();
        if let Ok(read) = std::fs::read_dir(cache.join("hls")) {
            for item in read.flatten() {
                let key = item.file_name().to_string_lossy().into_owned();
                if referenced_hls.contains(&key) || active.contains(&key) {
                    continue;
                }
                let bytes = directory_stats(&item.path()).0;
                if remove_artifact(&item.path(), true).is_ok() {
                    report.artifacts_removed += 1;
                    report.bytes_reclaimed += bytes;
                }
            }
        }
        if let Ok(read) = std::fs::read_dir(cache.join("thumbnails")) {
            for item in read.flatten() {
                let name = item.file_name().to_string_lossy().into_owned();
                if referenced_thumbnails.contains(&name) {
                    continue;
                }
                let bytes = item.metadata().map(|meta| meta.len()).unwrap_or(0);
                if remove_artifact(&item.path(), false).is_ok() {
                    report.artifacts_removed += 1;
                    report.bytes_reclaimed += bytes;
                }
            }
        }
        std::io::Result::Ok((index, report))
    })
    .await
    .map_err(ApiError::internal)??;
    persist_cache_index(&state.config.cache, &index).await?;
    *state.cache_index.write().await = index;
    Ok(report)
}

async fn evict_cache(state: &AppState, active: HashSet<String>) -> ApiResult<(u64, u64)> {
    let max_age = Duration::from_secs(state.config.cache_age_days * 24 * 60 * 60);
    let cache = state.config.cache.clone();
    let max_bytes = state.config.cache_max;
    tokio::task::spawn_blocking(move || {
        let mut units = Vec::<(PathBuf, u64, SystemTime, bool)>::new();
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
        let mut removed_count = 0;
        let mut reclaimed = 0;
        for (path, _, access, directory) in &units {
            if now.duration_since(*access).unwrap_or_default() > max_age {
                let bytes = units
                    .iter()
                    .find(|(candidate, _, _, _)| candidate == path)
                    .map(|(_, size, _, _)| *size)
                    .unwrap_or(0);
                if remove_artifact(path, *directory).is_ok() {
                    removed_count += 1;
                    reclaimed += bytes;
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
                removed_count += 1;
                reclaimed += size;
            }
        }
        std::io::Result::Ok((removed_count, reclaimed))
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(ApiError::internal)
}

async fn cleanup_cache(state: &AppState) -> ApiResult<CacheCleanupReport> {
    let _cleanup = state.cache_cleanup.lock().await;
    let _write = state.cache_write.lock().await;
    let active = state
        .media_jobs
        .iter()
        .filter(|job| job.status == "working")
        .map(|job| job.key.clone())
        .collect::<HashSet<_>>();
    let mut report = reconcile_cache(state, &active).await?;
    let (evicted, reclaimed) = evict_cache(state, active).await?;
    report.artifacts_removed += evicted;
    report.bytes_reclaimed += reclaimed;
    let mut index = state.cache_index.read().await.clone();
    let before = index.records.len();
    index
        .records
        .retain(|_, record| cache_artifact_path(&state.config.cache, record).exists());
    report.records_removed += (before - index.records.len()) as u64;
    persist_cache_index(&state.config.cache, &index).await?;
    *state.cache_index.write().await = index;
    Ok(report)
}

#[utoipa::path(post, path = "/api/v1/media/cache/cleanup", tag = "media", params(("x-csrf-token" = String, Header)), security(("sessionCookie" = []), ("csrfToken" = [])), responses((status = 200, body = CacheCleanupReport), (status = 401, body = Problem), (status = 403, body = Problem)))]
async fn request_cache_cleanup(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> ApiResult<Json<CacheCleanupReport>> {
    require_csrf(&state, &jar, &headers)?;
    let _ = state.live_events.send(LiveEvent::CacheCleanup {
        state: "started".into(),
        report: None,
        error: None,
    });
    match cleanup_cache(&state).await {
        Ok(report) => {
            let _ = state.live_events.send(LiveEvent::CacheCleanup {
                state: "complete".into(),
                report: Some(report.clone()),
                error: None,
            });
            Ok(Json(report))
        }
        Err(error) => {
            let _ = state.live_events.send(LiveEvent::CacheCleanup {
                state: "failed".into(),
                report: None,
                error: Some(error.2.clone()),
            });
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn markup_request(id: &str, etag: &str, bytes: &[u8]) -> axum::http::Request<Body> {
        let boundary = "rfb-markup-test-boundary";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"markup.png\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let encoded_etag = format!("%22{}%22", etag.trim_matches('"'));
        axum::http::Request::builder()
            .method("POST")
            .uri(format!(
                "/api/v1/editor/image-markup?id={id}&expectedEtag={encoded_etag}"
            ))
            .header(header::COOKIE, "rfb_session=session-token")
            .header("x-csrf-token", "csrf-token")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .unwrap()
    }

    fn test_state(root: &Path, token: Option<&str>) -> AppState {
        let cache = root.join(".cache/remote-file-browser");
        std::fs::create_dir_all(cache.join("hls")).unwrap();
        std::fs::create_dir_all(cache.join("thumbnails")).unwrap();
        let trash = root.join(".trash");
        std::fs::create_dir_all(trash.join("items")).unwrap();
        let (events, _) = broadcast::channel(16);
        AppState {
            config: Arc::new(Config {
                root: root.to_path_buf(),
                root_canonical: std::fs::canonicalize(root).unwrap(),
                trash,
                cache,
                username: "admin".into(),
                admin_password: AdminPasswordSource::Static("development-password".into()),
                secure_cookies: false,
                editor_max: 1024,
                upload_max: 1024,
                cache_max: 1024,
                cache_age_days: 1,
                terminal_enabled: true,
                terminal_shell: PathBuf::from("/bin/sh"),
                terminal_max_sessions: 2,
                vfx_editor_api_url: None,
            }),
            sessions: Arc::new(DashMap::new()),
            login_attempts: Arc::new(DashMap::new()),
            media_jobs: Arc::new(DashMap::new()),
            direct_playable: Arc::new(DashMap::new()),
            extraction_jobs: Arc::new(DashMap::new()),
            concatenation_jobs: Arc::new(DashMap::new()),
            provenance: Arc::new(RwLock::new(HashMap::new())),
            provenance_write: Arc::new(Mutex::new(())),
            cache_index: Arc::new(RwLock::new(CacheIndex::default())),
            cache_write: Arc::new(Mutex::new(())),
            cache_cleanup: Arc::new(Mutex::new(())),
            live_events: events,
            provenance_api_token: token.map(|value| Arc::new(value.to_string())),
            terminal_tickets: Arc::new(DashMap::new()),
            terminal_slots: Arc::new(Semaphore::new(2)),
        }
    }
    #[tokio::test]
    async fn login_reloads_rotated_password_file_and_handles_unreadable_secrets() {
        let root = tempfile::tempdir().unwrap();
        let password_path = root.path().join("admin_password");
        std::fs::write(&password_path, "initial-password\n").unwrap();
        let mut state = test_state(root.path(), None);
        Arc::get_mut(&mut state.config).unwrap().admin_password =
            AdminPasswordSource::File(password_path.clone());

        let initial = login(
            State(state.clone()),
            CookieJar::new(),
            HeaderMap::new(),
            Json(LoginRequest {
                username: "admin".into(),
                password: "initial-password".into(),
            }),
        )
        .await;
        assert!(initial.is_ok());

        std::fs::write(&password_path, "short\n").unwrap();
        let old_password = login(
            State(state.clone()),
            CookieJar::new(),
            HeaderMap::new(),
            Json(LoginRequest {
                username: "admin".into(),
                password: "initial-password".into(),
            }),
        )
        .await;
        assert!(matches!(
            old_password,
            Err(ApiError(StatusCode::UNAUTHORIZED, "invalid_credentials", _))
        ));
        let rotated = login(
            State(state.clone()),
            CookieJar::new(),
            HeaderMap::new(),
            Json(LoginRequest {
                username: "admin".into(),
                password: "short".into(),
            }),
        )
        .await;
        assert!(rotated.is_ok());

        std::fs::remove_file(password_path).unwrap();
        let unreadable = login(
            State(state),
            CookieJar::new(),
            HeaderMap::new(),
            Json(LoginRequest {
                username: "admin".into(),
                password: "short".into(),
            }),
        )
        .await;
        assert!(matches!(
            unreadable,
            Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                _
            ))
        ));
    }
    #[tokio::test]
    async fn vfx_integration_requires_configuration_and_video_sources() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("notes.txt"), b"not video").unwrap();
        let mut state = test_state(root.path(), None);
        state.sessions.insert(
            "session-token".into(),
            Session {
                csrf: "csrf-token".into(),
                expires: SystemTime::now() + Duration::from_secs(60),
            },
        );
        let jar = CookieJar::new().add(Cookie::new(SESSION_COOKIE, "session-token"));
        let mut headers = HeaderMap::new();
        headers.insert("x-csrf-token", "csrf-token".parse().unwrap());
        let unconfigured = open_vfx_project(
            State(state.clone()),
            jar.clone(),
            headers.clone(),
            Json(VfxProjectRequest {
                id: encode_path(OsStr::new("notes.txt")),
            }),
        )
        .await;
        assert!(matches!(
            unconfigured,
            Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "vfx_unavailable",
                _
            ))
        ));

        Arc::get_mut(&mut state.config).unwrap().vfx_editor_api_url =
            Some("http://127.0.0.1:9".into());
        let non_video = open_vfx_project(
            State(state),
            jar,
            headers,
            Json(VfxProjectRequest {
                id: encode_path(OsStr::new("notes.txt")),
            }),
        )
        .await;
        assert!(matches!(
            non_video,
            Err(ApiError(StatusCode::BAD_REQUEST, "not_video", _))
        ));
    }
    #[tokio::test]
    async fn vfx_export_is_streamed_beside_its_verified_source() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mock = Router::new()
            .route(
                "/api/integrations/remote-file-browser/projects/{key}",
                get(|| async { Json(serde_json::json!({ "id": "project-1" })) }),
            )
            .route(
                "/api/projects/project-1/media/export",
                get(|| async { ([(header::CONTENT_TYPE, "video/mp4")], b"final-video") }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });

        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("source.mov"), b"source-video").unwrap();
        let mut state = test_state(root.path(), None);
        Arc::get_mut(&mut state.config).unwrap().vfx_editor_api_url =
            Some(format!("http://{address}"));
        state.sessions.insert(
            "session-token".into(),
            Session {
                csrf: "csrf-token".into(),
                expires: SystemTime::now() + Duration::from_secs(60),
            },
        );
        let jar = CookieJar::new().add(Cookie::new(SESSION_COOKIE, "session-token"));
        let mut headers = HeaderMap::new();
        headers.insert("x-csrf-token", "csrf-token".parse().unwrap());
        let Json(published) = save_vfx_export(
            State(state),
            jar,
            headers,
            Json(VfxExportRequest {
                id: encode_path(OsStr::new("source.mov")),
                project_id: "project-1".into(),
            }),
        )
        .await
        .unwrap();

        assert_eq!(published.name, "source-edited.mp4");
        assert_eq!(published.id, encode_path(OsStr::new("source-edited.mp4")));
        assert_eq!(
            std::fs::read(root.path().join("source-edited.mp4")).unwrap(),
            b"final-video"
        );
        server.abort();
    }
    #[test]
    fn terminal_messages_enforce_types_and_limits() {
        assert!(matches!(
            parse_terminal_client_message(r#"{"type":"input","data":"ls\n"}"#),
            Ok(TerminalClientMessage::Input { data }) if data == "ls\n"
        ));
        assert!(matches!(
            parse_terminal_client_message(r#"{"type":"resize","cols":120,"rows":40}"#),
            Ok(TerminalClientMessage::Resize {
                cols: 120,
                rows: 40
            })
        ));
        assert!(parse_terminal_client_message(r#"{"type":"resize","cols":1,"rows":40}"#).is_err());
        let oversized = format!(
            r#"{{"type":"input","data":"{}"}}"#,
            "x".repeat(TERMINAL_MAX_INPUT_BYTES + 1)
        );
        assert!(parse_terminal_client_message(&oversized).is_err());
    }
    #[tokio::test]
    async fn terminal_tickets_are_root_confined_session_bound_and_single_use() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("work")).unwrap();
        let state = test_state(root.path(), None);
        state.sessions.insert(
            "session-token".into(),
            Session {
                csrf: "csrf-token".into(),
                expires: SystemTime::now() + Duration::from_secs(60),
            },
        );
        let jar = CookieJar::new().add(Cookie::new(SESSION_COOKIE, "session-token"));
        let mut headers = HeaderMap::new();
        headers.insert("x-csrf-token", "csrf-token".parse().unwrap());
        let Json(response) = create_terminal_ticket(
            State(state.clone()),
            jar,
            headers,
            Json(TerminalTicketRequest {
                directory_id: encode_path(OsStr::new("work")),
            }),
        )
        .await
        .unwrap();
        let ticket =
            take_terminal_ticket(&state, &response.ticket, "session-token", SystemTime::now())
                .unwrap();
        assert_eq!(ticket.directory, root.path().join("work"));
        assert!(
            take_terminal_ticket(&state, &response.ticket, "session-token", SystemTime::now())
                .is_err()
        );

        state.terminal_tickets.insert(
            "wrong-session".into(),
            TerminalTicket {
                session_token: "another-session".into(),
                directory: root.path().to_path_buf(),
                expires: SystemTime::now() + Duration::from_secs(60),
            },
        );
        assert!(
            take_terminal_ticket(&state, "wrong-session", "session-token", SystemTime::now())
                .is_err()
        );
    }
    #[tokio::test]
    async fn terminal_process_starts_in_the_requested_directory() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(root.path(), None);
        let (mut pty, mut child) = start_terminal_process(&state.config, root.path()).unwrap();
        let pid = child.id();
        pty.write_all(b"pwd\nexit\n").await.unwrap();
        let mut collected = Vec::new();
        let observed = tokio::time::timeout(Duration::from_secs(5), async {
            let mut buffer = [0_u8; 1024];
            loop {
                match pty.read(&mut buffer).await {
                    Ok(0) | Err(_) => return false,
                    Ok(read) => {
                        collected.extend_from_slice(&buffer[..read]);
                        if String::from_utf8_lossy(&collected)
                            .contains(&root.path().to_string_lossy().to_string())
                        {
                            return true;
                        }
                    }
                }
            }
        })
        .await
        .unwrap_or(false);
        stop_terminal_process(&mut child, pid).await;
        assert!(
            observed,
            "terminal output was {:?}",
            String::from_utf8_lossy(&collected)
        );
    }
    fn probe(video: (&str, &str), audio: Option<&str>) -> ProbeOutput {
        let mut streams = vec![ProbeStream {
            codec_type: Some("video".into()),
            codec_name: Some(video.0.into()),
            profile: None,
            pix_fmt: Some(video.1.into()),
            width: None,
            height: None,
            r_frame_rate: None,
            time_base: None,
            sample_rate: None,
            channels: None,
            channel_layout: None,
        }];
        if let Some(codec) = audio {
            streams.push(ProbeStream {
                codec_type: Some("audio".into()),
                codec_name: Some(codec.into()),
                profile: None,
                pix_fmt: None,
                width: None,
                height: None,
                r_frame_rate: None,
                time_base: None,
                sample_rate: None,
                channels: None,
                channel_layout: None,
            });
        }
        ProbeOutput {
            streams,
            format: Some(ProbeFormat {
                format_name: Some("mov,mp4,m4a,3gp,3g2,mj2".into()),
            }),
        }
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
    fn only_an_exact_readme_file_is_pinned() {
        assert!(is_readme_file("README.md", "file"));
        assert!(!is_readme_file("readme.md", "file"));
        assert!(!is_readme_file("README.md", "directory"));
    }
    #[test]
    fn submitted_paths_are_root_relative_and_normalized() {
        assert_eq!(
            submitted_path_id("folder/video.mp4").unwrap(),
            submitted_path_id("/folder/video.mp4").unwrap()
        );
        for invalid in [
            "",
            "/",
            ".",
            "../video.mp4",
            "folder/../video.mp4",
            "/fs-root/video.mp4",
            "//video.mp4",
        ] {
            assert!(
                submitted_path_id(invalid).is_err(),
                "{invalid} should be rejected"
            );
        }
    }
    #[test]
    fn provenance_token_is_optional_and_constant_time_checked() {
        let root = tempfile::tempdir().unwrap();
        let disabled = test_state(root.path(), None);
        assert_eq!(
            require_provenance_token(&disabled, &HeaderMap::new())
                .unwrap_err()
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let state = test_state(root.path(), Some("abcdefghijklmnopqrstuvwxyz123456"));
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            "Bearer abcdefghijklmnopqrstuvwxyz123456".parse().unwrap(),
        );
        assert!(require_provenance_token(&state, &headers).is_ok());
        headers.insert(header::AUTHORIZATION, "Bearer wrong".parse().unwrap());
        assert_eq!(
            require_provenance_token(&state, &headers).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn concurrent_appends_preserve_urls_and_broadcast_changes() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(root.path(), None);
        let mut events = state.live_events.subscribe();
        let first = append_provenance(
            &state,
            "file".into(),
            "/fs-root/file".into(),
            "https://one.example/source".into(),
        );
        let second = append_provenance(
            &state,
            "file".into(),
            "/fs-root/file".into(),
            "https://two.example/source".into(),
        );
        let (first, second) = tokio::join!(first, second);
        assert!(first.is_ok() && second.is_ok());
        let records = state.provenance.read().await;
        assert_eq!(records["file"].len(), 2);
        drop(records);
        assert!(events.recv().await.is_ok());
        assert!(events.recv().await.is_ok());
        let persisted: HashMap<String, Vec<String>> = serde_json::from_slice(
            &std::fs::read(state.config.cache.join("provenance.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted["file"].len(), 2);
    }
    #[test]
    fn openapi_documents_registered_routes_and_security() {
        let value = serde_json::to_value(ApiDoc::openapi()).unwrap();
        let paths = value["paths"].as_object().unwrap();
        for (path, methods) in [
            ("/healthz", &["get"][..]),
            ("/api/v1/auth/login", &["post"][..]),
            ("/api/v1/auth/session", &["get"][..]),
            ("/api/v1/auth/logout", &["post"][..]),
            ("/api/v1/fs/entries", &["get"][..]),
            ("/api/v1/fs/metadata", &["get"][..]),
            ("/api/v1/fs/provenance", &["get", "put", "post"][..]),
            ("/api/v1/events", &["get"][..]),
            ("/api/v1/fs/content", &["get"][..]),
            ("/api/v1/fs/items", &["post"][..]),
            ("/api/v1/fs/uploads", &["post"][..]),
            ("/api/v1/fs/operations", &["post"][..]),
            ("/api/v1/fs/trash", &["post"][..]),
            ("/api/v1/editor/document", &["get", "put"][..]),
            ("/api/v1/editor/image-markup", &["post"][..]),
            ("/api/v1/trash", &["get", "delete"][..]),
            ("/api/v1/trash/{id}/restore", &["post"][..]),
            ("/api/v1/trash/{id}", &["delete"][..]),
            ("/api/v1/previews/thumbnail", &["get"][..]),
            ("/api/v1/media/file", &["get"][..]),
            ("/api/v1/media/info", &["get"][..]),
            ("/api/v1/media/extractions", &["get", "post"][..]),
            ("/api/v1/media/extractions/{key}", &["get"][..]),
            ("/api/v1/media/concatenations", &["get", "post"][..]),
            ("/api/v1/media/hls", &["post"][..]),
            ("/api/v1/media/jobs", &["get"][..]),
            ("/api/v1/media/cache/cleanup", &["post"][..]),
            ("/api/v1/terminal/tickets", &["post"][..]),
            ("/api/v1/terminal/ws", &["get"][..]),
            ("/api/v1/media/hls/{key}/status", &["get"][..]),
            ("/api/v1/media/hls/{key}/{file}", &["get"][..]),
        ] {
            let operations = paths
                .get(path)
                .unwrap_or_else(|| panic!("OpenAPI is missing {path}"));
            for method in methods {
                assert!(
                    operations.get(method).is_some(),
                    "OpenAPI is missing {method} {path}"
                );
            }
        }
        let schemes = value["components"]["securitySchemes"].as_object().unwrap();
        for scheme in ["sessionCookie", "csrfToken", "provenanceToken"] {
            assert!(schemes.contains_key(scheme));
        }
    }
    #[test]
    fn permissions_are_symbolic() {
        assert_eq!(permission_string(0o754, "file"), "-rwxr-xr--");
    }
    #[tokio::test]
    async fn directory_property_counts_are_immediate_and_hide_internal_storage() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(root.path(), None);
        std::fs::write(root.path().join("visible.txt"), b"visible").unwrap();
        std::fs::write(root.path().join(".hidden"), b"hidden").unwrap();
        std::fs::create_dir(root.path().join("folder")).unwrap();
        std::fs::write(root.path().join("folder/nested.txt"), b"nested").unwrap();
        std::os::unix::fs::symlink("visible.txt", root.path().join("link")).unwrap();

        assert_eq!(
            directory_child_counts(root.path(), &state.config)
                .await
                .unwrap(),
            (3, 2)
        );

        std::fs::write(root.path().join(".cache/user.txt"), b"user cache").unwrap();
        assert_eq!(
            directory_child_counts(&root.path().join(".cache"), &state.config)
                .await
                .unwrap(),
            (1, 0)
        );
    }
    #[tokio::test]
    async fn directory_property_counts_are_optional_entry_fields() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(root.path(), None);
        let path = root.path().join("folder");
        std::fs::create_dir(&path).unwrap();
        let mut entry = entry_from_path(&state, path).await.unwrap();
        let ordinary = serde_json::to_value(&entry).unwrap();
        assert!(ordinary.get("childFileCount").is_none());
        assert!(ordinary.get("childDirectoryCount").is_none());

        entry.child_file_count = Some(2);
        entry.child_directory_count = Some(1);
        let properties = serde_json::to_value(entry).unwrap();
        assert_eq!(properties["childFileCount"], 2);
        assert_eq!(properties["childDirectoryCount"], 1);
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
    fn mp4_h264_aac_source_is_browser_compatible() {
        assert!(browser_compatible_source(&probe(
            ("h264", "yuv420p"),
            Some("aac")
        )));
        let mut mislabeled_container = probe(("h264", "yuv420p"), Some("aac"));
        mislabeled_container.format = Some(ProbeFormat {
            format_name: Some("asf".into()),
        });
        assert!(!browser_compatible_source(&mislabeled_container));
        assert!(!browser_compatible_source(&probe(
            ("hevc", "yuv420p"),
            Some("aac")
        )));
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
    fn frame_rates_are_parsed_safely() {
        assert_eq!(parse_frame_rate("30000/1001").unwrap(), 30000.0 / 1001.0);
        assert_eq!(parse_frame_rate("25/1"), Some(25.0));
        assert_eq!(parse_frame_rate("0/0"), None);
        assert_eq!(parse_frame_rate("invalid"), None);
    }
    #[test]
    fn extraction_times_and_names_are_stable() {
        assert!(valid_media_time(0.0, 10.0));
        assert!(valid_media_time(9.999, 10.0));
        assert!(!valid_media_time(10.0, 10.0));
        assert!(!valid_media_time(f64::NAN, 10.0));
        assert_eq!(timestamp_label(3661.234), "01-01-01.234");
    }
    #[test]
    fn concat_requests_require_safe_mp4_names_and_escape_list_paths() {
        assert!(valid_concat_output_name("combined.mp4"));
        assert!(valid_concat_output_name("COMBINED.MP4"));
        assert!(!valid_concat_output_name("combined.mov"));
        assert!(!valid_concat_output_name("folder/combined.mp4"));
        assert_eq!(
            concat_list_line(Path::new("/videos/one's clip.mp4")),
            "file '/videos/one'\\\\''s clip.mp4'\\n"
        );
    }
    #[test]
    fn concat_requires_matching_stream_layouts() {
        let first = probe(("h264", "yuv420p"), Some("aac"));
        let same = probe(("h264", "yuv420p"), Some("aac"));
        let different_audio = probe(("h264", "yuv420p"), Some("opus"));
        assert!(concat_compatible(&first, &same));
        assert!(!concat_compatible(&first, &different_audio));
    }
    #[test]
    fn frame_extraction_seeks_accurately_before_opening_the_input() {
        let command = frame_extraction_command(
            Path::new("/videos/source.mp4"),
            Path::new("/videos/frame.png"),
            12.3456789,
        );
        let arguments = command
            .as_std()
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            arguments,
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
                "-ss",
                "12.345679",
                "-accurate_seek",
                "-i",
                "/videos/source.mp4",
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-y",
                "/videos/frame.png",
            ]
        );
    }
    #[test]
    fn ffmpeg_progress_is_parsed_in_seconds() {
        assert_eq!(ffmpeg_progress_seconds("out_time_us=1250000"), Some(1.25));
        assert_eq!(ffmpeg_progress_seconds("progress=continue"), None);
        assert_eq!(ffmpeg_progress_seconds("out_time_us=-1"), None);
    }
    #[test]
    fn live_events_use_tagged_camel_case_messages() {
        assert_eq!(
            serde_json::to_value(LiveEvent::Resync).unwrap(),
            serde_json::json!({ "type": "resync" })
        );
        assert_eq!(
            serde_json::to_value(LiveEvent::Filesystem {
                directory_ids: vec!["folder".into()]
            })
            .unwrap(),
            serde_json::json!({ "type": "filesystem", "directoryIds": ["folder"] })
        );
    }
    #[test]
    fn cache_records_include_inode_identity_and_load_legacy_indexes() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("image.png");
        std::fs::write(&source, b"image").unwrap();
        let meta = std::fs::metadata(&source).unwrap();
        let mut record = CacheRecord {
            kind: "thumbnail".into(),
            key: "abc123".into(),
            source_id: "image.png".into(),
            source_inode: meta.ino() ^ 1,
            source_size: meta.len(),
            source_modified_ns: source_modified_ns(&meta),
            dimension: Some(192),
        };
        assert!(!cache_record_matches(
            &record,
            "thumbnail",
            "image.png",
            &meta,
            Some(192)
        ));
        record.source_inode = meta.ino();
        assert!(cache_record_matches(
            &record,
            "thumbnail",
            "image.png",
            &meta,
            Some(192)
        ));

        let legacy: CacheIndex = serde_json::from_value(serde_json::json!({
            "records": {
                "thumbnail:legacy": {
                    "kind": "thumbnail",
                    "key": "legacy",
                    "sourceId": "image.png",
                    "sourceSize": meta.len(),
                    "sourceModifiedNs": source_modified_ns(&meta),
                    "dimension": 192
                }
            }
        }))
        .unwrap();
        assert_eq!(legacy.records["thumbnail:legacy"].source_inode, 0);
    }
    #[tokio::test]
    async fn cache_association_and_active_job_follow_a_ui_move() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(root.path(), None);
        let source = root.path().join("source.mp4");
        let target = root.path().join("renamed.mp4");
        std::fs::write(&source, b"video").unwrap();
        let source_id = encode_path(OsStr::new("source.mp4"));
        let target_id = encode_path(OsStr::new("renamed.mp4"));
        let meta = std::fs::metadata(&source).unwrap();
        let key = "abc123".to_string();
        let directory = state.config.cache.join("hls").join(&key);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("segment-00000.ts"), b"segment").unwrap();
        std::fs::write(
            directory.join("index.m3u8"),
            "#EXTM3U\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n",
        )
        .unwrap();
        register_cache_record(
            &state,
            CacheRecord {
                kind: "hls".into(),
                key: key.clone(),
                source_id: source_id.clone(),
                source_inode: meta.ino(),
                source_size: meta.len(),
                source_modified_ns: source_modified_ns(&meta),
                dimension: None,
            },
        )
        .await
        .unwrap();
        state.media_jobs.insert(
            key.clone(),
            MediaJob {
                key: key.clone(),
                file_name: "source.mp4".into(),
                status: "working".into(),
                playable: true,
                mode: "full".into(),
                started_at: Utc::now(),
                progress: Some(0.5),
                source_id,
            },
        );
        std::fs::rename(&source, &target).unwrap();
        remap_cache(&state, &source, &target).await.unwrap();
        let target_meta = std::fs::metadata(&target).unwrap();
        assert_eq!(
            find_cache_key(&state, "hls", &target_id, &target_meta, None)
                .await
                .as_deref(),
            Some("abc123")
        );
        let job = state.media_jobs.get(&key).unwrap();
        assert_eq!(job.source_id, target_id);
        assert_eq!(job.file_name, "renamed.mp4");
        assert!(directory.exists());
    }
    #[tokio::test]
    async fn cache_cleanup_removes_orphans_but_preserves_valid_artifacts() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(root.path(), None);
        let source = root.path().join("video.mp4");
        std::fs::write(&source, b"video").unwrap();
        let meta = std::fs::metadata(&source).unwrap();
        let valid = state.config.cache.join("hls/abc123");
        std::fs::create_dir_all(&valid).unwrap();
        std::fs::write(valid.join("segment-00000.ts"), b"segment").unwrap();
        std::fs::write(
            valid.join("index.m3u8"),
            "#EXTM3U\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n",
        )
        .unwrap();
        register_cache_record(
            &state,
            CacheRecord {
                kind: "hls".into(),
                key: "abc123".into(),
                source_id: encode_path(OsStr::new("video.mp4")),
                source_inode: meta.ino(),
                source_size: meta.len(),
                source_modified_ns: source_modified_ns(&meta),
                dimension: None,
            },
        )
        .await
        .unwrap();
        let orphan = state.config.cache.join("hls/def456");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join("junk"), b"junk").unwrap();
        let report = cleanup_cache(&state).await.unwrap();
        assert!(!orphan.exists());
        assert!(valid.exists());
        assert_eq!(report.artifacts_removed, 1);
        assert_eq!(state.cache_index.read().await.records.len(), 1);
    }
    #[tokio::test]
    async fn extraction_publication_never_overwrites() {
        let directory = tempfile::tempdir().unwrap();
        let first_temporary = directory.path().join("first.tmp");
        std::fs::write(&first_temporary, b"first").unwrap();
        let first = publish_extraction(&first_temporary, directory.path(), "clip", "mp4")
            .await
            .unwrap();
        let second_temporary = directory.path().join("second.tmp");
        std::fs::write(&second_temporary, b"second").unwrap();
        let second = publish_extraction(&second_temporary, directory.path(), "clip", "mp4")
            .await
            .unwrap();
        assert_eq!(first.file_name().unwrap(), "clip.mp4");
        assert_eq!(second.file_name().unwrap(), "clip-2.mp4");
        assert_eq!(std::fs::read(first).unwrap(), b"first");
        assert_eq!(std::fs::read(second).unwrap(), b"second");
        assert!(!first_temporary.exists() && !second_temporary.exists());
    }
    #[tokio::test]
    async fn vfx_export_publication_uses_source_name_and_never_overwrites() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("original.mov");
        std::fs::write(&source, b"source").unwrap();
        let first_temporary = directory.path().join("first.tmp");
        std::fs::write(&first_temporary, b"first").unwrap();
        let first = publish_vfx_export_file(&first_temporary, &source)
            .await
            .unwrap();
        let second_temporary = directory.path().join("second.tmp");
        std::fs::write(&second_temporary, b"second").unwrap();
        let second = publish_vfx_export_file(&second_temporary, &source)
            .await
            .unwrap();
        assert_eq!(first.file_name().unwrap(), "original-edited.mp4");
        assert_eq!(second.file_name().unwrap(), "original-edited-2.mp4");
        assert_eq!(std::fs::read(first).unwrap(), b"first");
        assert_eq!(std::fs::read(second).unwrap(), b"second");
        assert!(!first_temporary.exists() && !second_temporary.exists());
    }
    #[tokio::test]
    async fn image_markup_publication_uses_source_name_and_never_overwrites() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("reference.jpg");
        std::fs::write(&source, b"source").unwrap();
        let first_temporary = directory.path().join("first.tmp");
        std::fs::write(&first_temporary, b"first").unwrap();
        let first = publish_image_markup_file(&first_temporary, &source)
            .await
            .unwrap();
        let second_temporary = directory.path().join("second.tmp");
        std::fs::write(&second_temporary, b"second").unwrap();
        let second = publish_image_markup_file(&second_temporary, &source)
            .await
            .unwrap();
        assert_eq!(first.file_name().unwrap(), "reference-markup.png");
        assert_eq!(second.file_name().unwrap(), "reference-markup-2.png");
        assert_eq!(std::fs::read(first).unwrap(), b"first");
        assert_eq!(std::fs::read(second).unwrap(), b"second");
        assert!(!first_temporary.exists() && !second_temporary.exists());
    }
    #[test]
    fn image_markup_requires_a_png_signature() {
        assert!(has_png_signature(PNG_SIGNATURE));
        assert!(has_png_signature(b"\x89PNG\r\n\x1a\nmore bytes"));
        assert!(!has_png_signature(b"not a png"));
        assert!(!has_png_signature(&PNG_SIGNATURE[..7]));
    }
    #[tokio::test]
    async fn image_markup_endpoint_rejects_stale_or_invalid_uploads_and_saves_png() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("reference.jpg");
        std::fs::write(&source, b"source image").unwrap();
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o640)).unwrap();
        let state = test_state(root.path(), None);
        state.sessions.insert(
            "session-token".into(),
            Session {
                csrf: "csrf-token".into(),
                expires: SystemTime::now() + Duration::from_secs(60),
            },
        );
        let app = Router::new()
            .route("/api/v1/editor/image-markup", post(save_image_markup))
            .with_state(state);
        let etag = metadata_etag(&std::fs::metadata(&source).unwrap());
        let source_id = encode_path(OsStr::new("reference.jpg"));

        let stale = app
            .clone()
            .oneshot(markup_request(&source_id, "stale", PNG_SIGNATURE))
            .await
            .unwrap();
        let stale_status = stale.status();
        let stale_body = axum::body::to_bytes(stale.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            stale_status,
            StatusCode::CONFLICT,
            "{}",
            String::from_utf8_lossy(&stale_body)
        );
        let invalid = app
            .clone()
            .oneshot(markup_request(&source_id, &etag, b"not a png"))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert!(
            !std::fs::read_dir(root.path())
                .unwrap()
                .flatten()
                .any(|item| item
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".rfb-image-markup-"))
        );

        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(b"markup payload");
        let saved = app
            .oneshot(markup_request(&source_id, &etag, &png))
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::CREATED);
        let target = root.path().join("reference-markup.png");
        assert_eq!(std::fs::read(&target).unwrap(), png);
        assert_eq!(
            std::fs::metadata(target).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(std::fs::read(source).unwrap(), b"source image");
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
        std::fs::remove_file(directory.path().join("segment-00000.ts")).unwrap();
        assert_eq!(playlist_state(directory.path()), (false, false));
    }

    #[tokio::test]
    async fn video_entry_is_browser_ready_once_its_cache_is_playable() {
        let root = tempfile::tempdir().unwrap();
        let state = test_state(root.path(), None);
        let source = root.path().join("video.mp4");
        std::fs::write(&source, b"video").unwrap();
        let id = encode_path(OsStr::new("video.mp4"));
        let source_meta = std::fs::metadata(&source).unwrap();
        let directory = hls_cache_directory(&state.config.cache, &id, &source_meta);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("segment-00000.ts"), b"segment").unwrap();
        std::fs::write(
            directory.join("index.m3u8"),
            "#EXTM3U\n#EXTINF:4,\nsegment-00000.ts\n",
        )
        .unwrap();

        assert!(
            entry_from_path(&state, source.clone())
                .await
                .unwrap()
                .browser_ready
        );

        std::fs::write(
            directory.join("index.m3u8"),
            "#EXTM3U\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n",
        )
        .unwrap();
        let ready = entry_from_path(&state, source.clone()).await.unwrap();
        assert!(ready.browser_ready);
        assert_eq!(serde_json::to_value(ready).unwrap()["browserReady"], true);

        std::fs::write(&source, b"changed video").unwrap();
        assert!(!entry_from_path(&state, source).await.unwrap().browser_ready);

        let text = root.path().join("notes.txt");
        std::fs::write(&text, b"notes").unwrap();
        let text_id = encode_path(OsStr::new("notes.txt"));
        let text_cache = hls_cache_directory(
            &state.config.cache,
            &text_id,
            &std::fs::metadata(&text).unwrap(),
        );
        std::fs::create_dir_all(&text_cache).unwrap();
        std::fs::write(text_cache.join("segment-00000.ts"), b"segment").unwrap();
        std::fs::write(
            text_cache.join("index.m3u8"),
            "#EXTM3U\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n",
        )
        .unwrap();
        assert!(!entry_from_path(&state, text).await.unwrap().browser_ready);
    }
}
