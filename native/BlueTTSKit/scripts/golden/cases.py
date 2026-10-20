"""Golden test cases for BlueTTSKit.

`[...]` marks an English span, exactly as in the listening spike's texts.py:
`plain()` is what the app hands the TTS, `tagged()` is the reference input with
`<en>` tags placed by hand. The Swift auto-tagger must turn plain() into
tagged(); the Swift front end on plain() must match the Python front end on
tagged().
"""
import re

# The 10 texts from the listening spike (/tmp/tts-spike/texts.py), verbatim.
SPIKE = [
    ("01", "mixed", "סיימתי את התיקון ב-[session-continue.ts], והבדיקות עוברות. נשאר רק לעשות [push] לבראנץ' [feat/quick-ask]."),
    ("02", "mixed", "הרצתי [pnpm test] ושלוש בדיקות נכשלו ב-[ChatInput.test.tsx]. נראה שה-[mock] של [useSessionStore] לא מחזיר את ה-[state] הנכון."),
    ("03", "mixed", "עדכנתי את ה-[Dockerfile] כדי לבנות עם [buildx] לפלטפורמה [linux/amd64], והאימג' עלה ל-[registry] בהצלחה."),
    ("04", "mixed", "מצאתי את הבאג: הפונקציה [parseAgentEvent] לא מטפלת ב-[null] כשה-[WebSocket] מתנתק. הוספתי בדיקה ושמתי את זה ב-[commit] נפרד."),
    ("05", "mixed", "פתחתי [Pull Request] מספר 412 עם השינויים ב-[README] וב-[CHANGELOG]. ה-[CI] ירוק, אפשר לעשות [merge]."),
    ("06", "he", "סיימתי לעבור על כל הקבצים. לא מצאתי בעיות נוספות, ואני מחכה להחלטה שלך לפני שאני ממשיך."),
    ("07", "he", "הבנייה נכשלה בגלל חוסר זיכרון בשרת. אני מנסה שוב עכשיו עם פחות תהליכים במקביל."),
    ("08", "en", "[I fixed the race condition in useSessionStore and pushed it to feat/quick-ask. The CI run is green, so you can merge whenever you're ready.]"),
    ("09", "en", "[The migration failed on the sessions table because of a missing index. Should I roll it back, or add the index and retry?]"),
    ("10", "long", "בדקתי את כל הזרימה של ה-[voice input] מקצה לקצה. ההקלטה עובדת, והתמלול עם [Whisper] חוזר תוך פחות משנייה. הבעיה היחידה היא שה-[AudioContext] נסגר כשהאפליקציה עוברת לרקע, ולכן ההקלטה השנייה נכשלת. זה קורה רק באייפון, במחשב הכל תקין. הוספתי [listener] ל-[visibilitychange] שפותח אותו מחדש, עדכנתי את הבדיקות ב-[voice-recorder.test.ts], ודחפתי הכל לבראנץ' [feat/voice-input]. רוצה שאפתח [Pull Request], או שקודם תבדוק את זה בעצמך?"),
]

# Extra Hebrew sentences: numbers, dates, times, prefixes (ב- ל- ה- ו- מ- כש-),
# code terms, an e-mail, a phone number, a geresh word.
EXTRA = [
    ("E01", "he", "הגרסה החדשה שוחררה ב-12/05/2024 ועברה את כל הבדיקות."),
    ("E02", "mixed", "הפגישה עם הצוות נקבעה ל-14:30, אחרי ה-[standup] של הבוקר."),
    ("E03", "mixed", "יש לנו 3 באגים פתוחים ו-12 בדיקות שנכשלו ב-[CI]."),
    ("E04", "mixed", "הכיסוי של הבדיקות עלה ל-85% אחרי השינוי ב-[useEffect]."),
    ("E05", "mixed", "הרצתי [npm install] ואז [npm run build], וזה לקח 47 שניות."),
    ("E06", "mixed", "צריך לעדכן את ה-[API] כך שיחזיר [JSON] ולא [XML]."),
    ("E07", "he", "שלחתי לך מייל ל-dev@example.com עם כל הפרטים."),
    ("E08", "he", "התקשר אליי למספר 03-5551234 אם משהו נשבר."),
    ("E09", "he", "המשתמשים העלו 1,500 קבצים בשבוע האחרון."),
    ("E10", "mixed", "עדכנתי את [Python] לגרסה 3.12 בכל השרתים."),
    ("E11", "mixed", "בדקתי את זה מול ה-[main] וגם מול ה-[develop], אין הבדלים."),
    ("E12", "mixed", "ה-[PR] מספר 1024 ממתין לסקירה כבר יומיים."),
    ("E13", "mixed", "כשה-[cache] מתמלא, השרת מתחיל להחזיר שגיאות 500."),
    ("E14", "he", "מהגרסה הקודמת ועד עכשיו נוספו 27 קבצים ונמחקו 9."),
    ("E15", "mixed", "שמתי את הקונפיגורציה ב-[config/settings.yaml] ובדקתי שהיא נטענת."),
    ("E16", "mixed", "בשלב הראשון נריץ [git rebase] על ה-[branch] הישן, ואחר כך נעשה [force push]."),
    ("E17", "he", "הזמן הממוצע לתגובה ירד מ-850 ל-320 מילישניות."),
    ("E18", "he", "המחיר של השרת החדש הוא 49.90 דולר לחודש."),
    ("E19", "mixed", "בתאריך 1.10.2025 עברנו ל-[Kubernetes] בכל הסביבות."),
    ("E20", "mixed", "לפי ה-[logs], ה-[worker] נפל בשעה 03:15 בלילה."),
    ("E21", "mixed", "ה-[iPhone] של ג'וני לא מתחבר ל-[Wi-Fi] של המשרד."),
    ("E22", "mixed", "הקובץ [README.md] עודכן, ו-[TODO] אחד נשאר פתוח."),
    ("E23", "en", "[Run the migration at 10:30 and check that 95% of the 1,200 tests pass.]"),
]

# English terms for EspeakPhonemizer parity (phonemizer + espeak-ng 1.52.0).
ESPEAK_TERMS = [
    "session-continue.ts", "push", "feat/quick-ask", "pnpm test", "ChatInput.test.tsx", "mock",
    "useSessionStore", "state", "Dockerfile", "buildx", "linux/amd64", "registry", "parseAgentEvent",
    "null", "WebSocket", "commit", "Pull Request", "README", "CHANGELOG", "CI", "merge", "voice input",
    "Whisper", "AudioContext", "listener", "visibilitychange", "voice-recorder.test.ts", "feat/voice-input",
    "Hello, world!", "Is it ready?", "Wait... what", "C++ and C#", "e.g. this one", "a (parenthesized) word",
    "\"quoted\" text", "1,5 and 2.75", "v2.3.1", "localhost:3000", "Kubernetes", "Wi-Fi", "iPhone",
    "npm run build", "git rebase -i HEAD~3", "JSON", "API", "OAuth 2.0", "x86_64", "TODO", "README.md",
    "you're ready; don't wait", "ten thirty", "ninety-five percent",
]

# Hebrew-only sentences for RenikudPlus parity beyond the pipeline cases.
RENIKUD_EXTRA = [
    "בוקר טוב, מה שלומך היום?",
    "הספרייה החדשה נפתחה ליד בית הספר.",
    "אני צריך לבדוק את זה שוב לפני שאני שולח.",
    "הוא כתב שלושה מכתבים ושלח אותם בדואר.",
    "הילדים שיחקו בחצר עד שהתחיל לרדת גשם.",
    "המחשב נתקע באמצע העדכון ונאלצתי להפעיל אותו מחדש.",
    "תזכיר לי מחר בבוקר לקנות חלב ולחם.",
    "הממשלה הודיעה על צעדים חדשים לצמצום יוקר המחיה.",
    "בשבוע הבא נטוס לאילת לשלושה ימים.",
    "הקוד עובד, אבל הוא איטי מדי בשביל הפרודקשן.",
    "שכחתי את הסיסמה ואני לא מצליח להתחבר.",
    "הפרויקט התעכב בגלל בעיות בתקציב.",
    "בשנת 1948 הוכרזה מדינת ישראל.",
    "קומה 3, דירה 12.",
    "יש לי פגישה בשעה 8:45 ואחריה עוד אחת ב-10.",
]

_SPAN = re.compile(r"\[([^\]]+)\]")


def plain(t: str) -> str:
    return _SPAN.sub(r"\1", t)


def tagged(t: str) -> str:
    return _SPAN.sub(r"<en>\1</en>", t)
