//! DO IT's `save_recipe` (F): the recipe on the page in front, read from its schema.org Recipe
//! JSON-LD (no model call), or, for pages without it, structured by the server from the page's
//! text. Saved to the "Recipe Book" notebook with its title, its original-language name next
//! to the other, ingredients, steps, servings, time, the source address and a picture.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_ITEMS: usize = 80;
const ITEM_MAX: usize = 400;
/// The most page text sent for structuring, when there's no JSON-LD.
pub const TEXT_MAX: usize = 12_000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub title: String,
    /// The name in the page's own language, when it isn't the title's (e.g. "Bhuna Khichuri"
    /// beside "Spiced rice and lentils").
    pub original_title: Option<String>,
    pub ingredients: Vec<String>,
    pub steps: Vec<String>,
    pub servings: Option<String>,
    pub time: Option<String>,
    pub source_url: Option<String>,
    pub thumbnail: Option<String>,
}

fn clean(text: &str, max: usize) -> Option<String> {
    let text: String = decode_entities(&strip_tags(text))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect();
    (!text.is_empty()).then_some(text)
}

fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    for c in text.chars() {
        match c {
            '<' => inside = true,
            '>' if inside => {
                inside = false;
                out.push(' ');
            }
            _ if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// The contents of every `<script type="application/ld+json">` in `html`.
pub fn json_ld_blocks(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = lower[from..].find("<script") {
        let start = from + at;
        let Some(tag_end) = lower[start..].find('>').map(|i| start + i) else {
            break;
        };
        let tag = &lower[start..tag_end];
        let Some(close) = lower[tag_end..].find("</script").map(|i| tag_end + i) else {
            break;
        };
        if tag.contains("application/ld+json") {
            out.push(html[tag_end + 1..close].to_owned());
        }
        from = close + 8;
        if out.len() >= 20 {
            break;
        }
    }
    out
}

fn is_recipe(node: &Value) -> bool {
    match node.get("@type") {
        Some(Value::String(t)) => t == "Recipe",
        Some(Value::Array(types)) => types.iter().any(|t| t == "Recipe"),
        _ => false,
    }
}

/// The first Recipe node anywhere in a JSON-LD value (top level, a list, or `@graph`).
fn find_recipe(value: &Value, depth: u32) -> Option<&Value> {
    if depth > 4 {
        return None;
    }
    if is_recipe(value) {
        return Some(value);
    }
    match value {
        Value::Array(items) => items.iter().find_map(|v| find_recipe(v, depth + 1)),
        Value::Object(map) => map.get("@graph").and_then(|g| find_recipe(g, depth + 1)),
        _ => None,
    }
}

fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => clean(s, ITEM_MAX),
        Value::Number(n) => Some(n.to_string()),
        Value::Array(items) => items.iter().find_map(text_of),
        Value::Object(map) => map
            .get("text")
            .or_else(|| map.get("name"))
            .or_else(|| map.get("url"))
            .and_then(text_of),
        _ => None,
    }
}

/// HowToStep, HowToSection, plain strings, or one long string with line breaks.
fn steps_of(value: &Value, out: &mut Vec<String>, depth: u32) {
    if depth > 4 || out.len() >= MAX_ITEMS {
        return;
    }
    match value {
        Value::String(s) => {
            for part in s.split(['\n', '\r']).filter_map(|p| clean(p, ITEM_MAX)) {
                if out.len() < MAX_ITEMS {
                    out.push(part);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|v| steps_of(v, out, depth + 1)),
        Value::Object(map) => {
            if let Some(list) = map.get("itemListElement") {
                steps_of(list, out, depth + 1);
            } else if let Some(text) = map.get("text").and_then(text_of) {
                out.push(text);
            } else if let Some(name) = map.get("name").and_then(text_of) {
                out.push(name);
            }
        }
        _ => {}
    }
}

/// "PT1H20M" → "1 h 20 min".
pub fn duration(iso: &str) -> Option<String> {
    let rest = iso
        .trim()
        .strip_prefix("PT")
        .or_else(|| iso.trim().strip_prefix("P0DT"))?;
    let (mut hours, mut minutes, mut number) = (0u32, 0u32, String::new());
    for c in rest.chars() {
        match c {
            '0'..='9' => number.push(c),
            'H' => hours = std::mem::take(&mut number).parse().ok()?,
            'M' => minutes = std::mem::take(&mut number).parse().ok()?,
            'S' => number.clear(),
            _ => return None,
        }
    }
    hours += minutes / 60;
    minutes %= 60;
    match (hours, minutes) {
        (0, 0) => None,
        (0, m) => Some(format!("{m} min")),
        (h, 0) => Some(format!("{h} h")),
        (h, m) => Some(format!("{h} h {m} min")),
    }
}

/// A recipe from one JSON-LD block, if it holds one with a name and some ingredients or steps.
pub fn from_json_ld(block: &str, page_url: Option<&str>) -> Option<Recipe> {
    let value: Value = serde_json::from_str(block.trim()).ok()?;
    let node = find_recipe(&value, 0)?;
    let title = node.get("name").and_then(text_of)?;
    let ingredients: Vec<String> = node
        .get("recipeIngredient")
        .or_else(|| node.get("ingredients"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(text_of).take(MAX_ITEMS).collect())
        .unwrap_or_default();
    let mut steps = Vec::new();
    if let Some(instructions) = node.get("recipeInstructions") {
        steps_of(instructions, &mut steps, 0);
    }
    if ingredients.is_empty() && steps.is_empty() {
        return None;
    }
    let alternate = node
        .get("alternateName")
        .and_then(text_of)
        .filter(|a| *a != title);
    let time = ["totalTime", "cookTime", "prepTime"]
        .iter()
        .find_map(|k| node.get(*k).and_then(Value::as_str).and_then(duration));
    let source_url = node
        .get("url")
        .and_then(Value::as_str)
        .or(page_url)
        .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
        .map(|u| u.chars().take(2000).collect());
    let thumbnail = node
        .get("image")
        .and_then(text_of)
        .filter(|u| u.starts_with("https://"));
    Some(Recipe {
        title,
        original_title: alternate,
        ingredients,
        steps,
        servings: node.get("recipeYield").and_then(text_of),
        time,
        source_url,
        thumbnail,
    })
}

/// The recipe from a page's HTML, if it has JSON-LD for one.
pub fn from_html(html: &str, page_url: Option<&str>) -> Option<Recipe> {
    json_ld_blocks(html)
        .iter()
        .find_map(|block| from_json_ld(block, page_url))
}

/// The page's readable text (scripts, styles and tags removed), for structuring by the server.
pub fn page_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut kept = String::with_capacity(html.len().min(200_000));
    let mut from = 0;
    while from < html.len() {
        let next = ["<script", "<style", "<noscript"]
            .iter()
            .filter_map(|tag| lower[from..].find(tag).map(|i| (from + i, *tag)))
            .min_by_key(|(i, _)| *i);
        match next {
            Some((at, tag)) => {
                kept.push_str(&html[from..at]);
                let close = format!("</{}", &tag[1..]);
                from = lower[at..]
                    .find(&close)
                    .map_or(html.len(), |i| at + i + close.len());
            }
            None => {
                kept.push_str(&html[from..]);
                break;
            }
        }
    }
    clean(&kept, TEXT_MAX).unwrap_or_default()
}

/// The recipe for a page: from its JSON-LD when it has one (no model call at all), otherwise
/// `structure` (the server, one question) on the page's readable text, or on `screen_text`
/// (what's on the screen, redacted) when the page couldn't be read.
pub fn read_or_structure(
    html: Option<&str>,
    page_url: Option<&str>,
    screen_text: impl FnOnce() -> String,
    structure: impl FnOnce(&str) -> Result<Recipe, String>,
) -> Result<Recipe, String> {
    if let Some(recipe) = html.and_then(|h| from_html(h, page_url)) {
        return Ok(recipe);
    }
    let text = html
        .map(page_text)
        .filter(|t| t.chars().count() >= 200)
        .unwrap_or_else(screen_text);
    if text.trim().chars().count() < 20 {
        return Err("I couldn't find a recipe on this page.".into());
    }
    structure(&text)
}

impl Recipe {
    /// The text kept with the saved page (searchable in the notebook).
    pub fn to_text(&self, max: usize) -> String {
        let mut out = self.title.clone();
        if let Some(original) = &self.original_title {
            out.push_str(&format!(" ({original})"));
        }
        let facts: Vec<String> = [
            self.servings.as_ref().map(|s| format!("Serves: {s}")),
            self.time.as_ref().map(|t| format!("Time: {t}")),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !facts.is_empty() {
            out.push_str(&format!("\n{}", facts.join(" · ")));
        }
        if !self.ingredients.is_empty() {
            out.push_str("\n\nIngredients\n");
            out.push_str(
                &self
                    .ingredients
                    .iter()
                    .map(|i| format!("• {i}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        if !self.steps.is_empty() {
            out.push_str("\n\nSteps\n");
            out.push_str(
                &self
                    .steps
                    .iter()
                    .enumerate()
                    .map(|(n, s)| format!("{}. {s}", n + 1))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        if let Some(url) = &self.source_url {
            out.push_str(&format!("\n\nSource: {url}"));
        }
        out.chars().take(max).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<html><head><title>Khichuri</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Food"},
{"@type":["Recipe","NewsArticle"],"name":"Bhuna Khichuri","alternateName":"Spiced rice and lentils",
"recipeIngredient":["1 cup rice","1/2 cup moong dal &amp; ghee"],
"recipeInstructions":[{"@type":"HowToSection","name":"Prep","itemListElement":[{"@type":"HowToStep","text":"Wash the rice."}]},
{"@type":"HowToStep","text":"Fry the <b>spices</b>."}],
"recipeYield":["4","4 servings"],"totalTime":"PT1H20M","image":{"@type":"ImageObject","url":"https://img.example/k.jpg"}}]}</script>
<script>var x = "<script type='application/ld+json'>";</script></head><body><p>Hello</p></body></html>"#;

    #[test]
    fn reads_a_recipe_from_json_ld() {
        let recipe = from_html(PAGE, Some("https://food.example/khichuri")).unwrap();
        assert_eq!(recipe.title, "Bhuna Khichuri");
        assert_eq!(
            recipe.original_title.as_deref(),
            Some("Spiced rice and lentils")
        );
        assert_eq!(
            recipe.ingredients,
            vec!["1 cup rice", "1/2 cup moong dal & ghee"]
        );
        assert_eq!(recipe.steps, vec!["Wash the rice.", "Fry the spices ."]);
        assert_eq!(recipe.servings.as_deref(), Some("4"));
        assert_eq!(recipe.time.as_deref(), Some("1 h 20 min"));
        assert_eq!(
            recipe.source_url.as_deref(),
            Some("https://food.example/khichuri")
        );
        assert_eq!(
            recipe.thumbnail.as_deref(),
            Some("https://img.example/k.jpg")
        );
        let text = recipe.to_text(8000);
        assert!(text
            .starts_with("Bhuna Khichuri (Spiced rice and lentils)\nServes: 4 · Time: 1 h 20 min"));
        assert!(text.contains("• 1 cup rice") && text.contains("2. Fry the spices"));
    }

    #[test]
    fn pages_without_a_recipe_have_none() {
        assert!(from_html("<html><body>No recipe</body></html>", None).is_none());
        let article =
            r#"<script type="application/ld+json">{"@type":"Article","name":"x"}</script>"#;
        assert!(from_html(article, None).is_none());
        let broken = r#"<script type="application/ld+json">{"@type":"Recipe",</script>"#;
        assert!(from_html(broken, None).is_none());
    }

    #[test]
    fn json_ld_makes_no_model_call_and_its_absence_makes_one() {
        let mut calls = 0;
        let r = read_or_structure(Some(PAGE), None, String::new, |_| {
            calls += 1;
            Err("no".into())
        });
        assert_eq!(r.unwrap().title, "Bhuna Khichuri");
        assert_eq!(calls, 0, "a page with JSON-LD must never reach the model");

        let mut calls = 0;
        let plain = format!(
            "<html><body>{}</body></html>",
            "Rice and lentils, cooked slowly. ".repeat(10)
        );
        let r = read_or_structure(Some(&plain), None, String::new, |text| {
            calls += 1;
            assert!(text.contains("Rice and lentils"));
            Ok(Recipe {
                title: "Khichuri".into(),
                ..Recipe::default()
            })
        });
        assert_eq!(r.unwrap().title, "Khichuri");
        assert_eq!(calls, 1);

        // An unreadable page falls back to the screen's text.
        let r = read_or_structure(
            None,
            None,
            || "Khichuri: rice, lentils, ghee. Fry, then simmer.".into(),
            |t| {
                Ok(Recipe {
                    title: t[..8].into(),
                    ..Recipe::default()
                })
            },
        );
        assert_eq!(r.unwrap().title, "Khichuri");
    }

    #[test]
    fn durations_read_as_people_say_them() {
        assert_eq!(duration("PT45M").as_deref(), Some("45 min"));
        assert_eq!(duration("PT90M").as_deref(), Some("1 h 30 min"));
        assert_eq!(duration("PT2H").as_deref(), Some("2 h"));
        assert_eq!(duration("P0DT0H35M").as_deref(), Some("35 min"));
        assert_eq!(duration("soon"), None);
    }

    #[test]
    fn page_text_leaves_scripts_out() {
        let text = page_text(PAGE);
        assert!(text.contains("Hello"));
        assert!(!text.contains("moong") && !text.contains("var x"));
    }
}
