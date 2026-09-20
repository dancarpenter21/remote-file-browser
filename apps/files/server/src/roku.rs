use super::*;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::net::UdpSocket;

const DISCOVERY_WINDOW: Duration = Duration::from_secs(2);
const DEVICE_TTL: Duration = Duration::from_secs(5 * 60);
const STREAM_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const RECEIVER_NAME: &str = "Remote Workspace Receiver";

#[derive(Clone)]
pub(crate) struct RokuDeviceRecord {
    pub device: RokuDevice,
    pub address: Ipv4Addr,
    pub seen_at: SystemTime,
}

#[derive(Clone)]
pub(crate) struct RokuCastRecord {
    pub id: Uuid,
    pub device_id: String,
    pub device_name: String,
    pub is_tv: bool,
    pub address: Ipv4Addr,
    pub source_id: String,
    pub file_name: String,
    pub token: String,
    pub hls_key: Option<String>,
    pub status: String,
    pub progress: Option<f64>,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone)]
pub(crate) struct RokuStreamToken {
    pub hls_key: String,
    pub expires: SystemTime,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RokuDevice {
    pub id: String,
    pub name: String,
    pub model: String,
    pub is_tv: bool,
    pub receiver_installed: bool,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RokuCast {
    pub id: Uuid,
    pub device_id: String,
    pub device_name: String,
    pub is_tv: bool,
    pub source_id: String,
    pub file_name: String,
    pub status: String,
    pub progress: Option<f64>,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl From<&RokuCastRecord> for RokuCast {
    fn from(value: &RokuCastRecord) -> Self {
        Self {
            id: value.id,
            device_id: value.device_id.clone(),
            device_name: value.device_name.clone(),
            is_tv: value.is_tv,
            source_id: value.source_id.clone(),
            file_name: value.file_name.clone(),
            status: value.status.clone(),
            progress: value.progress,
            position_seconds: value.position_seconds,
            duration_seconds: value.duration_seconds,
            error: value.error.clone(),
            created_at: value.created_at,
        }
    }
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartCastRequest {
    pub source_id: String,
    pub device_id: String,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CastControlRequest {
    pub action: String,
    pub position_seconds: Option<f64>,
}

fn ensure_enabled(state: &AppState) -> ApiResult<&str> {
    if !state.config.roku_enabled {
        return Err(ApiError::bad("roku_disabled", "Roku casting is disabled"));
    }
    state.config.roku_stream_base_url.as_deref().ok_or_else(|| {
        ApiError::bad(
            "roku_stream_url_missing",
            "FILES_ROKU_STREAM_BASE_URL is required when Roku casting is enabled",
        )
    })
}

fn private_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

fn header_value<'a>(response: &'a str, name: &str) -> Option<&'a str> {
    response.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn valid_location(response: &str, source: SocketAddr) -> Option<(Ipv4Addr, String)> {
    let IpAddr::V4(source_ip) = source.ip() else { return None };
    if !private_ipv4(source_ip) { return None }
    let location = header_value(response, "location")?;
    let url = reqwest::Url::parse(location).ok()?;
    if url.scheme() != "http" || url.port_or_known_default()? != 8060 { return None }
    let host = url.host_str()?.parse::<Ipv4Addr>().ok()?;
    if host != source_ip { return None }
    Some((source_ip, format!("http://{source_ip}:8060")))
}

fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let start_marker = format!("<{tag}>");
    let end_marker = format!("</{tag}>");
    let start = xml.find(&start_marker)? + start_marker.len();
    let end = xml[start..].find(&end_marker)? + start;
    Some(xml[start..end].trim().replace("&amp;", "&"))
}

async fn inspect_device(state: &AppState, ip: Ipv4Addr, base: &str) -> Option<RokuDeviceRecord> {
    let info = state.roku_http.get(format!("{base}/query/device-info")).send().await.ok()?.error_for_status().ok()?.text().await.ok()?;
    let apps = state.roku_http.get(format!("{base}/query/apps")).send().await.ok()?.error_for_status().ok()?.text().await.ok()?;
    let id = xml_text(&info, "udn").or_else(|| xml_text(&info, "serial-number"))?;
    let name = xml_text(&info, "friendly-device-name").or_else(|| xml_text(&info, "user-device-name")).unwrap_or_else(|| "Roku".into());
    let model = xml_text(&info, "model-name").unwrap_or_else(|| "Roku device".into());
    let is_tv = xml_text(&info, "is-tv").is_some_and(|value| value.eq_ignore_ascii_case("true"));
    let receiver_installed = apps.lines().any(|line| line.contains("id=\"dev\"") && line.contains(RECEIVER_NAME));
    Some(RokuDeviceRecord {
        device: RokuDevice { id, name, model, is_tv, receiver_installed },
        address: ip,
        seen_at: SystemTime::now(),
    })
}

async fn scan(state: &AppState) -> ApiResult<Vec<RokuDevice>> {
    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let request = b"M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\nMan: \"ssdp:discover\"\r\nMX: 2\r\nST: roku:ecp\r\n\r\n";
    socket.send_to(request, "239.255.255.250:1900").await?;
    let deadline = tokio::time::Instant::now() + DISCOVERY_WINDOW;
    let mut candidates = HashMap::<Ipv4Addr, String>::new();
    let mut buffer = [0u8; 4096];
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() { break }
        match tokio::time::timeout(remaining, socket.recv_from(&mut buffer)).await {
            Ok(Ok((length, source))) => {
                let response = String::from_utf8_lossy(&buffer[..length]);
                if let Some((ip, base)) = valid_location(&response, source) { candidates.insert(ip, base); }
            }
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => break,
        }
    }
    let mut devices = Vec::new();
    for (ip, base) in candidates {
        if let Some(record) = inspect_device(state, ip, &base).await {
            devices.push(record.device.clone());
            state.roku_devices.insert(record.device.id.clone(), record);
        }
    }
    devices.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(devices)
}

#[utoipa::path(get, path = "/api/v1/roku/devices", tag = "roku", security(("sessionCookie" = [])), responses((status = 200, body = [RokuDevice]), (status = 401, body = Problem)))]
pub(crate) async fn discover_devices(State(state): State<AppState>, jar: CookieJar) -> ApiResult<Json<Vec<RokuDevice>>> {
    require_session(&state, &jar)?;
    ensure_enabled(&state)?;
    Ok(Json(scan(&state).await?))
}

fn prune_expired(state: &AppState) {
    let now = SystemTime::now();
    state.roku_devices.retain(|_, device| now.duration_since(device.seen_at).unwrap_or_default() < DEVICE_TTL);
    state.roku_tokens.retain(|_, token| token.expires > now);
}

async fn refresh_cast(state: &AppState, id: Uuid) {
    let Some(record) = state.roku_casts.get(&id).map(|entry| entry.clone()) else { return };
    if !matches!(record.status.as_str(), "playing" | "paused" | "buffering") { return }
    let url = format!("http://{}:8060/query/media-player", record.address);
    let Ok(response) = state.roku_http.get(url).send().await else { return };
    let Ok(xml) = response.text().await else { return };
    let state_name = xml.split("state=\"").nth(1).and_then(|tail| tail.split('"').next()).unwrap_or("");
    let status = match state_name { "play" => "playing", "pause" => "paused", "buffer" => "buffering", "close" | "none" => "stopped", _ => record.status.as_str() };
    let milliseconds = |tag: &str| xml_text(&xml, tag).and_then(|value| value.split_whitespace().next()?.parse::<f64>().ok()).unwrap_or(0.0) / 1000.0;
    if let Some(mut cast) = state.roku_casts.get_mut(&id) {
        cast.status = status.into();
        cast.position_seconds = milliseconds("position");
        cast.duration_seconds = milliseconds("duration");
    }
}

#[utoipa::path(get, path = "/api/v1/roku/casts", tag = "roku", security(("sessionCookie" = [])), responses((status = 200, body = [RokuCast])))]
pub(crate) async fn list_casts(State(state): State<AppState>, jar: CookieJar) -> ApiResult<Json<Vec<RokuCast>>> {
    require_session(&state, &jar)?;
    ensure_enabled(&state)?;
    prune_expired(&state);
    let ids = state.roku_casts.iter().map(|cast| *cast.key()).collect::<Vec<_>>();
    for id in ids { refresh_cast(&state, id).await; }
    let mut casts = state.roku_casts.iter().map(|cast| RokuCast::from(cast.value())).collect::<Vec<_>>();
    casts.sort_by_key(|cast| cast.created_at);
    Ok(Json(casts))
}

async fn launch_when_ready(state: AppState, cast_id: Uuid, source: PathBuf, base_url: String) {
    let Some(record) = state.roku_casts.get(&cast_id).map(|cast| cast.clone()) else { return };
    let prepared = prepare_hls(&state, &record.source_id, &source, |_| String::new()).await;
    let Ok((_, response)) = prepared else {
        if let Some(mut cast) = state.roku_casts.get_mut(&cast_id) { cast.status = "failed".into(); cast.error = Some("Video conversion could not be started".into()); }
        return;
    };
    let key = response.key.clone();
    loop {
        let status = hls_status_for(&state, &key, String::new());
        let Ok(job) = status else {
            if let Some(mut cast) = state.roku_casts.get_mut(&cast_id) { cast.status = "failed".into(); cast.error = Some("Video conversion status was lost".into()); }
            return;
        };
        if let Some(mut cast) = state.roku_casts.get_mut(&cast_id) { cast.progress = job.progress; cast.hls_key = Some(key.clone()); }
        if job.playable { break }
        if job.status == "failed" {
            if let Some(mut cast) = state.roku_casts.get_mut(&cast_id) { cast.status = "failed".into(); cast.error = job.error; }
            return;
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    state.roku_tokens.insert(record.token.clone(), RokuStreamToken { hls_key: key, expires: SystemTime::now() + STREAM_TTL });
    let content_id = format!("{base_url}/cast/{}/index.m3u8", record.token);
    let url = format!("http://{}:8060/launch/dev", record.address);
    let launched = state.roku_http.post(url).query(&[("contentId", content_id), ("mediaType", "movie".into())]).body("").send().await;
    match launched.and_then(|response| response.error_for_status()) {
        Ok(_) => { if let Some(mut cast) = state.roku_casts.get_mut(&cast_id) { cast.status = "playing".into(); cast.progress = Some(1.0); } }
        Err(error) => { state.roku_tokens.remove(&record.token); if let Some(mut cast) = state.roku_casts.get_mut(&cast_id) { cast.status = "failed".into(); cast.error = Some(format!("Roku launch failed: {error}")); } }
    }
}

#[utoipa::path(post, path = "/api/v1/roku/casts", tag = "roku", request_body = StartCastRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 202, body = RokuCast)))]
pub(crate) async fn start_cast(State(state): State<AppState>, jar: CookieJar, headers: HeaderMap, Json(input): Json<StartCastRequest>) -> ApiResult<(StatusCode, Json<RokuCast>)> {
    require_csrf(&state, &jar, &headers)?;
    let base_url = ensure_enabled(&state)?.to_string();
    prune_expired(&state);
    let device = state.roku_devices.get(&input.device_id).map(|entry| entry.clone()).ok_or_else(|| ApiError::bad("roku_not_discovered", "Refresh Roku devices and try again"))?;
    if !device.device.receiver_installed { return Err(ApiError::bad("roku_receiver_missing", "Remote Workspace Receiver is not installed in the Roku development slot")); }
    let source = resolve_existing(&state.config, &input.source_id).await?;
    let metadata = fs::metadata(&source).await?;
    if !metadata.is_file() || mime_guess::from_path(&source).first_or_octet_stream().type_() != mime_guess::mime::VIDEO { return Err(ApiError::bad("not_video", "Only video files can be cast")); }
    for mut existing in state.roku_casts.iter_mut().filter(|cast| cast.device_id == input.device_id && !matches!(cast.status.as_str(), "stopped" | "failed")) {
        state.roku_tokens.remove(&existing.token);
        existing.status = "stopped".into();
    }
    let id = Uuid::new_v4();
    let record = RokuCastRecord {
        id, device_id: input.device_id, device_name: device.device.name.clone(), is_tv: device.device.is_tv, address: device.address,
        source_id: input.source_id, file_name: source.file_name().unwrap_or_else(|| OsStr::new("video")).to_string_lossy().into_owned(),
        token: random_token(), hls_key: None, status: "preparing".into(), progress: Some(0.0), position_seconds: 0.0,
        duration_seconds: 0.0, error: None, created_at: Utc::now(),
    };
    state.roku_casts.insert(id, record.clone());
    tokio::spawn(launch_when_ready(state.clone(), id, source, base_url));
    Ok((StatusCode::ACCEPTED, Json(RokuCast::from(&record))))
}

async fn ecp_input(state: &AppState, address: Ipv4Addr, pairs: &[(&str, String)]) -> ApiResult<()> {
    state.roku_http.post(format!("http://{address}:8060/input")).query(pairs).body("").send().await.map_err(|_| ApiError::bad("roku_unreachable", "The Roku did not accept the control command"))?.error_for_status().map_err(|_| ApiError::bad("roku_control_failed", "The Roku rejected the control command"))?;
    Ok(())
}

#[utoipa::path(post, path = "/api/v1/roku/casts/{id}/control", tag = "roku", params(("id" = Uuid, Path)), request_body = CastControlRequest, security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 200, body = RokuCast)))]
pub(crate) async fn control_cast(State(state): State<AppState>, jar: CookieJar, headers: HeaderMap, AxumPath(id): AxumPath<Uuid>, Json(input): Json<CastControlRequest>) -> ApiResult<Json<RokuCast>> {
    require_csrf(&state, &jar, &headers)?;
    let record = state.roku_casts.get(&id).map(|cast| cast.clone()).ok_or_else(|| ApiError::not_found("Cast session not found"))?;
    match input.action.as_str() {
        "play" | "pause" | "stop" => ecp_input(&state, record.address, &[("command", input.action.clone())]).await?,
        "seek" => {
            let position = input.position_seconds.filter(|value| value.is_finite() && *value >= 0.0).ok_or_else(|| ApiError::bad("invalid_seek", "A non-negative seek position is required"))?;
            ecp_input(&state, record.address, &[("command", "seek".into()), ("position", position.to_string())]).await?;
        }
        "volumeUp" | "volumeDown" | "mute" => {
            let key = match input.action.as_str() { "volumeUp" => "VolumeUp", "volumeDown" => "VolumeDown", _ => "VolumeMute" };
            state.roku_http.post(format!("http://{}:8060/keypress/{key}", record.address)).body("").send().await.map_err(|_| ApiError::bad("roku_unreachable", "The Roku did not accept the volume command"))?.error_for_status().map_err(|_| ApiError::bad("roku_control_failed", "The Roku rejected the volume command"))?;
        }
        _ => return Err(ApiError::bad("invalid_roku_control", "Unknown Roku control action")),
    }
    if input.action == "stop" { state.roku_tokens.remove(&record.token); if let Some(mut cast) = state.roku_casts.get_mut(&id) { cast.status = "stopped".into(); } }
    refresh_cast(&state, id).await;
    Ok(Json(RokuCast::from(state.roku_casts.get(&id).unwrap().value())))
}

#[utoipa::path(delete, path = "/api/v1/roku/casts/{id}", tag = "roku", params(("id" = Uuid, Path)), security(("sessionCookie" = [], "csrfToken" = [])), responses((status = 204)))]
pub(crate) async fn stop_cast(State(state): State<AppState>, jar: CookieJar, headers: HeaderMap, AxumPath(id): AxumPath<Uuid>) -> ApiResult<StatusCode> {
    require_csrf(&state, &jar, &headers)?;
    let (_, record) = state.roku_casts.remove(&id).ok_or_else(|| ApiError::not_found("Cast session not found"))?;
    let _ = ecp_input(&state, record.address, &[("command", "stop".into())]).await;
    state.roku_tokens.remove(&record.token);
    Ok(StatusCode::NO_CONTENT)
}

async fn stream_asset(State(state): State<AppState>, headers: HeaderMap, AxumPath((token, file)): AxumPath<(String, String)>) -> ApiResult<Response> {
    if !state.config.roku_enabled { return Err(ApiError::not_found("Cast stream not found")); }
    let Some(capability) = state.roku_tokens.get(&token).map(|entry| entry.clone()) else { return Err(ApiError::not_found("Cast stream not found")); };
    if capability.expires <= SystemTime::now() { state.roku_tokens.remove(&token); return Err(ApiError::not_found("Cast stream expired")); }
    serve_hls_asset(&state, &headers, &capability.hls_key, &file).await
}

pub(crate) fn stream_router(state: AppState) -> Router {
    Router::new().route("/cast/{token}/{file}", get(stream_asset)).with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_private_matching_roku_locations() {
        let response = "HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.25:8060/\r\n\r\n";
        assert!(valid_location(response, "192.168.1.25:1900".parse().unwrap()).is_some());
        assert!(valid_location(response, "192.168.1.26:1900".parse().unwrap()).is_none());
        assert!(valid_location("HTTP/1.1 200 OK\r\nLOCATION: http://8.8.8.8:8060/\r\n", "8.8.8.8:1900".parse().unwrap()).is_none());
        assert!(valid_location("HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.25:80/\r\n", "192.168.1.25:1900".parse().unwrap()).is_none());
    }

    #[test]
    fn extracts_device_xml_fields() {
        let xml = "<device-info><udn>uuid:roku</udn><friendly-device-name>Living Room</friendly-device-name><is-tv>true</is-tv></device-info>";
        assert_eq!(xml_text(xml, "udn").as_deref(), Some("uuid:roku"));
        assert_eq!(xml_text(xml, "friendly-device-name").as_deref(), Some("Living Room"));
    }
}
