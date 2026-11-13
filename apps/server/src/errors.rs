use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Erro de API no formato `{ error, message }` que o app já entende.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

pub fn not_found(what: &str) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "not_found",
        format!("{what} não encontrado"),
    )
}
pub fn forbidden(message: &str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "forbidden", message)
}
pub fn bad_request(message: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "bad_request", message)
}
pub fn conflict(message: &str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", message)
}
pub fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "Sessão inválida, entre novamente",
    )
}
pub fn validation(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "validation", message)
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": self.code, "message": self.message })),
        )
            .into_response()
    }
}
