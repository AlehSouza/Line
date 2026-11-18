//! `/hoje [cidade]`: o agente responde com a data, se é feriado nacional, a previsão do tempo
//! (Open-Meteo, sem chave) e uma curiosidade do dia (Wikipédia "Neste dia").
use chrono::{Datelike, Duration, NaiveDate, Utc};
use std::time::Duration as StdDuration;

const DEFAULT_CITY: &str = "São Paulo";
const UA: &str = "Line/1.0 (https://useline.tech)";

const WEEKDAYS: [&str; 7] = [
    "segunda-feira",
    "terça-feira",
    "quarta-feira",
    "quinta-feira",
    "sexta-feira",
    "sábado",
    "domingo",
];
const MONTHS: [&str; 12] = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
];

/// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher).
fn easter(year: i32) -> NaiveDate {
    let a = year % 19;
    let b = year / 100;
    let c = year % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = (h + l - 7 * m + 114) % 31 + 1;
    NaiveDate::from_ymd_opt(year, month as u32, day as u32).unwrap()
}

/// Feriados nacionais (e os pontos facultativos mais conhecidos) do ano.
fn holidays(year: i32) -> Vec<(NaiveDate, &'static str)> {
    let d = |m, dd| NaiveDate::from_ymd_opt(year, m, dd).unwrap();
    let p = easter(year);
    let mut list = vec![
        (d(1, 1), "Confraternização Universal"),
        (p - Duration::days(48), "Carnaval (ponto facultativo)"),
        (p - Duration::days(47), "Carnaval (ponto facultativo)"),
        (p - Duration::days(2), "Sexta-feira Santa"),
        (p, "Páscoa"),
        (d(4, 21), "Tiradentes"),
        (d(5, 1), "Dia do Trabalho"),
        (p + Duration::days(60), "Corpus Christi (ponto facultativo)"),
        (d(9, 7), "Independência do Brasil"),
        (d(10, 12), "Nossa Senhora Aparecida"),
        (d(11, 2), "Finados"),
        (d(11, 15), "Proclamação da República"),
        (d(11, 20), "Dia da Consciência Negra"),
        (d(12, 25), "Natal"),
    ];
    list.sort_by_key(|(date, _)| *date);
    list
}

fn weather_text(code: i64) -> (&'static str, &'static str) {
    match code {
        0 => ("☀️", "céu limpo"),
        1 => ("🌤️", "quase sem nuvens"),
        2 => ("⛅", "parcialmente nublado"),
        3 => ("☁️", "nublado"),
        45 | 48 => ("🌫️", "neblina"),
        51 | 53 | 55 | 56 | 57 => ("🌦️", "garoa"),
        61 | 63 | 66 => ("🌧️", "chuva"),
        65 | 67 => ("🌧️", "chuva forte"),
        71 | 73 | 75 | 77 | 85 | 86 => ("🌨️", "neve"),
        80 | 81 => ("🌦️", "pancadas de chuva"),
        82 => ("⛈️", "pancadas fortes de chuva"),
        95 | 96 | 99 => ("⛈️", "tempestade"),
        _ => ("🌡️", "tempo instável"),
    }
}

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(StdDuration::from_secs(6))
        .user_agent(UA)
        .build()
        .ok()
}

/// Siglas dos estados (a lista de sugestões do app manda "Natal, RN").
const UFS: [(&str, &str); 27] = [
    ("AC", "Acre"),
    ("AL", "Alagoas"),
    ("AP", "Amapá"),
    ("AM", "Amazonas"),
    ("BA", "Bahia"),
    ("CE", "Ceará"),
    ("DF", "Distrito Federal"),
    ("ES", "Espírito Santo"),
    ("GO", "Goiás"),
    ("MA", "Maranhão"),
    ("MT", "Mato Grosso"),
    ("MS", "Mato Grosso do Sul"),
    ("MG", "Minas Gerais"),
    ("PA", "Pará"),
    ("PB", "Paraíba"),
    ("PR", "Paraná"),
    ("PE", "Pernambuco"),
    ("PI", "Piauí"),
    ("RJ", "Rio de Janeiro"),
    ("RN", "Rio Grande do Norte"),
    ("RS", "Rio Grande do Sul"),
    ("RO", "Rondônia"),
    ("RR", "Roraima"),
    ("SC", "Santa Catarina"),
    ("SP", "São Paulo"),
    ("SE", "Sergipe"),
    ("TO", "Tocantins"),
];

/// Minúsculas e sem acento, para comparar nomes.
fn fold(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            c => c,
        })
        .collect()
}

async fn weather(city: &str) -> Option<String> {
    let http = client()?;
    // "Cidade, UF" ou "Cidade, País": a parte depois da vírgula escolhe entre cidades de mesmo nome.
    let (name, hint) = match city.split_once(',') {
        Some((n, h)) => (n.trim(), h.trim()),
        None => (city.trim(), ""),
    };
    let state = UFS
        .iter()
        .find(|(uf, _)| uf.eq_ignore_ascii_case(hint))
        .map(|(_, s)| *s);
    let mut query = vec![
        ("name", name),
        ("count", "10"),
        ("language", "pt"),
        ("format", "json"),
    ];
    if state.is_some() {
        query.push(("countryCode", "BR"));
    }
    let geo: serde_json::Value = http
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&query)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let results = geo.get("results")?.as_array()?;
    let want = fold(state.unwrap_or(hint));
    let field =
        |p: &serde_json::Value, k: &str| fold(p.get(k).and_then(|v| v.as_str()).unwrap_or(""));
    let place = (!want.is_empty())
        .then(|| {
            results
                .iter()
                .find(|p| field(p, "admin1") == want || field(p, "country") == want)
        })
        .flatten()
        .or_else(|| results.first())?;
    let (lat, lon) = (
        place.get("latitude")?.as_f64()?,
        place.get("longitude")?.as_f64()?,
    );
    let name = place.get("name")?.as_str()?.to_string();
    let region = place.get("admin1").and_then(|v| v.as_str()).unwrap_or("");
    let f: serde_json::Value = http
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "temperature_2m,weather_code".into()),
            (
                "daily",
                "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
                    .into(),
            ),
            ("timezone", "auto".into()),
            ("forecast_days", "1".into()),
        ])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let daily = f.get("daily")?;
    let first = |k: &str| daily.get(k).and_then(|v| v.get(0)).and_then(|v| v.as_f64());
    let code = first("weather_code").unwrap_or(-1.0) as i64;
    let (icon, desc) = weather_text(code);
    let mut parts = vec![desc.to_string()];
    if let Some(now) = f
        .get("current")
        .and_then(|c| c.get("temperature_2m"))
        .and_then(|v| v.as_f64())
    {
        parts.push(format!("agora {:.0}°C", now));
    }
    if let (Some(min), Some(max)) = (first("temperature_2m_min"), first("temperature_2m_max")) {
        parts.push(format!("mín {:.0}°C, máx {:.0}°C", min, max));
    }
    if let Some(rain) = first("precipitation_probability_max") {
        parts.push(format!("chuva {:.0}%", rain));
    }
    let place = if region.is_empty() || region == name {
        name
    } else {
        format!("{name}, {region}")
    };
    Some(format!(
        "{icon} **Tempo em {place}:** {}",
        parts.join(" · ")
    ))
}

async fn curiosity(month: u32, day: u32, seed: usize) -> Option<String> {
    let http = client()?;
    let url = format!(
        "https://api.wikimedia.org/feed/v1/wikipedia/pt/onthisday/selected/{month:02}/{day:02}"
    );
    let v: serde_json::Value = http.get(url).send().await.ok()?.json().await.ok()?;
    let list = v.get("selected")?.as_array()?;
    if list.is_empty() {
        return None;
    }
    let item = &list[seed % list.len()];
    let text = item.get("text")?.as_str()?.trim();
    let year = item.get("year").and_then(|y| y.as_i64());
    Some(match year {
        Some(y) => format!("💡 **Neste dia, em {y}:** {text}"),
        None => format!("💡 **Neste dia:** {text}"),
    })
}

/// Monta a resposta do `/hoje`. `city` vazio = São Paulo.
pub async fn report(city: &str) -> String {
    // Horário de Brasília (sem horário de verão desde 2019).
    let now = Utc::now() - Duration::hours(3);
    let today = now.date_naive();
    let city = if city.trim().is_empty() {
        DEFAULT_CITY
    } else {
        city.trim()
    };
    let (w, c) = tokio::join!(
        weather(city),
        curiosity(today.month(), today.day(), today.ordinal() as usize)
    );

    let mut lines = vec![format!(
        "📅 **Hoje é {}, {} de {} de {}**",
        WEEKDAYS[today.weekday().num_days_from_monday() as usize],
        today.day(),
        MONTHS[today.month0() as usize],
        today.year()
    )];
    let mut all = holidays(today.year());
    all.extend(holidays(today.year() + 1));
    let todays: Vec<&str> = all
        .iter()
        .filter(|(d, _)| *d == today)
        .map(|(_, n)| *n)
        .collect();
    if todays.is_empty() {
        lines.push("🗓️ Não é feriado nacional.".into());
    } else {
        lines.push(format!("🎉 **Feriado:** {}", todays.join(" / ")));
    }
    if let Some((d, name)) = all.iter().find(|(d, _)| *d > today) {
        let days = (*d - today).num_days();
        lines.push(format!(
            "⏭️ Próximo: {name}, {:02}/{:02} ({}, {})",
            d.day(),
            d.month(),
            WEEKDAYS[d.weekday().num_days_from_monday() as usize],
            if days == 1 {
                "amanhã".to_string()
            } else {
                format!("daqui a {days} dias")
            }
        ));
    }
    lines
        .push(w.unwrap_or_else(|| format!("🌡️ Não consegui ver a previsão do tempo para {city}.")));
    if let Some(c) = c {
        lines.push(c);
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pascoa() {
        assert_eq!(easter(2026), NaiveDate::from_ymd_opt(2026, 4, 5).unwrap());
        assert_eq!(easter(2025), NaiveDate::from_ymd_opt(2025, 4, 20).unwrap());
    }
}
