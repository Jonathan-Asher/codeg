//! What a push says. The session notifications use the desktop
//! notification's own wording (the frontend's
//! `Folder.chat.acpConnections.notification*`, `permissionDialog.subtitle`
//! and `planApproval.title` messages, copied here per language — a test keeps
//! the copies in step with the message files); critical alerts use the
//! chat-channel wording the watchdog already sends.

use crate::acp::critical_watch::CriticalAlertKind;
use crate::chat_channel::i18n::{self as channel_i18n, Lang};

/// One language's message templates.
struct Templates {
    turn_complete: &'static str,
    question: &'static str,
    error: &'static str,
    permission_subtitle: &'static str,
    plan_title: &'static str,
    test_body: &'static str,
}

fn templates(lang: Lang) -> Templates {
    match lang {
        Lang::ZhCn => Templates {
            turn_complete: "{agent} 已完成响应",
            question: "{agent} 正在等你回答",
            error: "{agent} 错误：{message}",
            permission_subtitle: "Agent 请求继续当前轮次的权限。",
            plan_title: "智能体已给出计划——请审阅",
            test_body: "测试推送：iPhone 通知已就绪。",
        },
        Lang::ZhTw => Templates {
            turn_complete: "{agent} 已完成回應",
            question: "{agent} 正在等你回答",
            error: "{agent} 錯誤：{message}",
            permission_subtitle: "Agent 請求繼續目前輪次的權限。",
            plan_title: "智慧代理已提出計畫——請審閱",
            test_body: "測試推播：iPhone 通知已就緒。",
        },
        Lang::Ja => Templates {
            turn_complete: "{agent} の応答が完了しました",
            question: "{agent} が回答を待っています",
            error: "{agent} エラー：{message}",
            permission_subtitle: "エージェントがこのターンを続行するための許可を要求しています。",
            plan_title: "エージェントが計画を提示しました — 確認してください",
            test_body: "テスト通知：iPhone への通知は準備できています。",
        },
        Lang::Ko => Templates {
            turn_complete: "{agent} 응답이 완료되었습니다",
            question: "{agent}이(가) 답변을 기다리고 있습니다",
            error: "{agent} 오류: {message}",
            permission_subtitle: "에이전트가 이 턴을 계속하기 위한 권한을 요청합니다.",
            plan_title: "에이전트가 계획을 제시했습니다 — 검토하세요",
            test_body: "테스트 알림: iPhone 알림이 준비되었습니다.",
        },
        Lang::Es => Templates {
            turn_complete: "{agent} ha terminado de responder",
            question: "{agent} espera tu respuesta",
            error: "{agent} error: {message}",
            permission_subtitle: "El agente solicita permiso para continuar este turno.",
            plan_title: "El agente tiene un plan: revísalo",
            test_body: "Notificación de prueba: los avisos en el iPhone funcionan.",
        },
        Lang::De => Templates {
            turn_complete: "{agent} hat die Antwort abgeschlossen",
            question: "{agent} wartet auf deine Antwort",
            error: "{agent} Fehler: {message}",
            permission_subtitle: "Agent fordert Berechtigung an, um diesen Zug fortzusetzen.",
            plan_title: "Der Agent hat einen Plan – bitte prüfen",
            test_body: "Testmitteilung: Benachrichtigungen auf dem iPhone funktionieren.",
        },
        Lang::Fr => Templates {
            turn_complete: "{agent} a terminé de répondre",
            question: "{agent} attend votre réponse",
            error: "{agent} erreur : {message}",
            permission_subtitle: "L'agent demande une autorisation pour continuer ce tour.",
            plan_title: "L'agent a un plan — à vérifier",
            test_body: "Notification de test : les alertes sur l'iPhone fonctionnent.",
        },
        Lang::Pt => Templates {
            turn_complete: "{agent} terminou de responder",
            question: "{agent} está aguardando sua resposta",
            error: "{agent} erro: {message}",
            permission_subtitle: "O agente solicita permissão para continuar este turno.",
            plan_title: "O agente tem um plano — revise",
            test_body: "Notificação de teste: os avisos no iPhone estão funcionando.",
        },
        Lang::Ar => Templates {
            turn_complete: "{agent} أنهى الاستجابة",
            question: "{agent} ينتظر إجابتك",
            error: "{agent} خطأ: {message}",
            permission_subtitle: "يطلب الوكيل إذنًا لمتابعة هذا الدور.",
            plan_title: "لدى الوكيل خطة — راجعها",
            test_body: "إشعار تجريبي: إشعارات iPhone تعمل.",
        },
        Lang::En => Templates {
            turn_complete: "{agent} has finished responding",
            question: "{agent} is waiting for your answer",
            error: "{agent} error: {message}",
            permission_subtitle: "Agent requests permission to continue this turn.",
            plan_title: "The agent has a plan — review it",
            test_body: "Test notification: iPhone alerts are working.",
        },
    }
}

fn fill(template: &str, agent: &str, message: &str) -> String {
    template
        .replace("{agent}", agent)
        .replace("{message}", message)
}

pub fn turn_finished(lang: Lang, agent: &str) -> String {
    fill(templates(lang).turn_complete, agent, "")
}

pub fn question(lang: Lang, agent: &str) -> String {
    fill(templates(lang).question, agent, "")
}

/// The desktop's `{agent}: {permissionDialog.subtitle}`.
pub fn permission(lang: Lang, agent: &str) -> String {
    format!("{agent}: {}", templates(lang).permission_subtitle)
}

/// Same shape as the permission body, with the plan card's title.
pub fn plan(lang: Lang, agent: &str) -> String {
    format!("{agent}: {}", templates(lang).plan_title)
}

pub fn error(lang: Lang, agent: &str, message: &str) -> String {
    fill(templates(lang).error, agent, message.trim())
}

pub fn test_body(lang: Lang) -> &'static str {
    templates(lang).test_body
}

/// The desktop notification's title and body for a session: the session's
/// title when it has one (the body then names the folder), else
/// "<folder> - Codeg".
pub fn session_title_and_body(
    session_title: Option<&str>,
    folder_name: Option<&str>,
    content: String,
) -> (String, String) {
    let folder_name = folder_name.map(str::trim).filter(|f| !f.is_empty());
    let folder_title = match folder_name {
        Some(folder) => format!("{folder} - Codeg"),
        None => "Codeg".to_string(),
    };
    match session_title.map(str::trim).filter(|t| !t.is_empty()) {
        None => (folder_title, content),
        Some(title) => (
            title.to_string(),
            match folder_name {
                Some(folder) => format!("{folder} · {content}"),
                None => content,
            },
        ),
    }
}

/// A critical alert: "⚑ <headline>: <session>", and what it is about.
pub fn critical(
    lang: Lang,
    kind: CriticalAlertKind,
    session_title: Option<&str>,
) -> (String, String) {
    let session = session_title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| channel_i18n::critical_untitled(lang));
    (
        format!(
            "⚑ {}: {session}",
            channel_i18n::critical_alert_title(lang, kind)
        ),
        channel_i18n::critical_alert_body(lang, kind).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANGS: [(Lang, &str, &str); 10] = [
        (
            Lang::En,
            "en",
            include_str!("../../../src/i18n/messages/en.json"),
        ),
        (
            Lang::ZhCn,
            "zh-CN",
            include_str!("../../../src/i18n/messages/zh-CN.json"),
        ),
        (
            Lang::ZhTw,
            "zh-TW",
            include_str!("../../../src/i18n/messages/zh-TW.json"),
        ),
        (
            Lang::Ja,
            "ja",
            include_str!("../../../src/i18n/messages/ja.json"),
        ),
        (
            Lang::Ko,
            "ko",
            include_str!("../../../src/i18n/messages/ko.json"),
        ),
        (
            Lang::Es,
            "es",
            include_str!("../../../src/i18n/messages/es.json"),
        ),
        (
            Lang::De,
            "de",
            include_str!("../../../src/i18n/messages/de.json"),
        ),
        (
            Lang::Fr,
            "fr",
            include_str!("../../../src/i18n/messages/fr.json"),
        ),
        (
            Lang::Pt,
            "pt",
            include_str!("../../../src/i18n/messages/pt.json"),
        ),
        (
            Lang::Ar,
            "ar",
            include_str!("../../../src/i18n/messages/ar.json"),
        ),
    ];

    /// The copies above are the desktop notification's wording; a change to
    /// a message file must be carried here too.
    #[test]
    fn the_wording_matches_the_desktop_messages() {
        for (lang, name, raw) in LANGS {
            let messages: serde_json::Value = serde_json::from_str(raw).unwrap();
            let chat = &messages["Folder"]["chat"];
            let acp = &chat["acpConnections"];
            let t = templates(lang);
            assert_eq!(acp["notificationTurnComplete"], t.turn_complete, "{name}");
            assert_eq!(acp["notificationQuestion"], t.question, "{name}");
            assert_eq!(acp["notificationError"], t.error, "{name}");
            assert_eq!(
                chat["permissionDialog"]["subtitle"], t.permission_subtitle,
                "{name}"
            );
            assert_eq!(chat["planApproval"]["title"], t.plan_title, "{name}");
        }
    }

    #[test]
    fn bodies_fill_the_agent_and_message() {
        assert_eq!(
            turn_finished(Lang::En, "Claude Code"),
            "Claude Code has finished responding"
        );
        assert_eq!(
            permission(Lang::En, "Codex CLI"),
            "Codex CLI: Agent requests permission to continue this turn."
        );
        assert_eq!(
            error(Lang::En, "Pi", " rate limited \n"),
            "Pi error: rate limited"
        );
    }

    #[test]
    fn the_title_is_the_session_and_the_body_names_the_folder() {
        assert_eq!(
            session_title_and_body(Some("Fix login"), Some("codeg"), "done".into()),
            ("Fix login".to_string(), "codeg · done".to_string())
        );
        assert_eq!(
            session_title_and_body(Some("  "), Some("codeg"), "done".into()),
            ("codeg - Codeg".to_string(), "done".to_string())
        );
        assert_eq!(
            session_title_and_body(None, None, "done".into()),
            ("Codeg".to_string(), "done".to_string())
        );
    }

    #[test]
    fn a_critical_alert_names_its_session() {
        let (title, body) = critical(Lang::En, CriticalAlertKind::NeedsYou, Some("Deploy"));
        assert_eq!(title, "⚑ Critical session needs you: Deploy");
        assert!(!body.is_empty());
        let (untitled, _) = critical(Lang::En, CriticalAlertKind::Idle, None);
        assert!(untitled.starts_with("⚑ Critical session waiting: "));
    }
}
