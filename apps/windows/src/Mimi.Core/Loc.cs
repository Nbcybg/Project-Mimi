namespace Mimi.Core;

/// <summary>
/// The app's language (the web's i18n.js: Thai or English, shared by the account's devices as <c>mimi.lang</c>).
/// Text is written in Thai in the code; <see cref="T"/> gives the English of the texts the web has translated, and
/// the Thai itself for every other text — a half-translated screen still works, as it does on the web.
/// The table is the web's (packages/ui/i18n.js, Thai text to English text): regenerate it from there, do not edit it by hand.
/// </summary>
public static class Loc
{
    public static readonly IReadOnlyList<(string Code, string Name)> Languages = [("th", "ไทย"), ("en", "English")];

    /// <summary>"th" or "en".</summary>
    public static string Language { get; private set; } = "th";

    public static event Action? Changed;

    public static void Set(string? code)
    {
        var next = Languages.Any(language => language.Code == code) ? code! : "th";
        if (next == Language) return;
        Language = next;
        Changed?.Invoke();
    }

    /// <summary>The text in the chosen language (Thai when it has no translation).</summary>
    public static string T(string thai) => Language == "en" && English.TryGetValue(thai, out var english) ? english : thai;

    private static readonly Dictionary<string, string> English = new()
    {
        ["คุณ"] = "You",
        ["(ข้อความ)"] = "(message)",
        ["(ไฟล์)"] = "(file)",
        ["แชต"] = "Chat",
        ["ตัวต่อตัว"] = "One-to-one",
        ["วันนี้"] = "Today",
        ["เมื่อวาน"] = "Yesterday",
        ["เริ่ม session ใหม่อัตโนมัติ"] = "New session started automatically",
        ["การอ่านออกเสียง"] = "Read aloud",
        ["อารมณ์"] = "Emotion",
        ["น้ำเสียง"] = "Tone",
        ["เสียง"] = "Voice",
        ["ความเร็ว"] = "Speed",
        ["ตอบกลับ"] = "Reply",
        ["ส่งต่อ"] = "Forward",
        ["ส่งต่อข้อความ"] = "Forward message",
        ["ส่งต่อแล้ว"] = "Forwarded",
        ["ไม่มีแชตอื่นให้ส่งต่อ"] = "No other chat to forward to",
        ["คัดลอก"] = "Copy",
        ["คัดลอกข้อความ"] = "Copy text",
        ["คัดลอกแล้ว"] = "Copied",
        ["คัดลอกไม่ได้"] = "Could not copy",
        ["เลือกข้อความแล้วคัดลอกเอง"] = "Select the text and copy it yourself",
        ["ถูกใจ"] = "Like",
        ["เลิกถูกใจ"] = "Unlike",
        ["แสดงความรู้สึก"] = "React",
        ["เอาปฏิกิริยานี้ออก"] = "Remove this reaction",
        ["ปักหมุด"] = "Pin",
        ["เลิกปักหมุด"] = "Unpin",
        ["ข้อความที่ปักหมุด"] = "Pinned messages",
        ["ไม่มีข้อความที่ปักหมุด"] = "No pinned messages",
        ["เลิกปัก"] = "Unpin",
        ["ทั้งหมด"] = "All",
        ["ดูทั้งหมด"] = "View all",
        ["อิโมจิ"] = "Emoji",
        ["‹ เลื่อนออกด้านข้างเพื่อยกเลิก ›"] = "‹ Slide sideways to cancel ›",
        ["🗑 ปล่อยเพื่อยกเลิก"] = "🗑 Release to cancel",
        ["แตะไมค์เพื่อหยุด"] = "Tap the mic to stop",
        ["✕ ยกเลิก"] = "✕ Cancel",
        ["อัดเสียงไม่ได้"] = "Cannot record",
        ["เบราว์เซอร์นี้ไม่รองรับ แนบไฟล์เสียงแทนได้"] = "This browser does not support it; attach an audio file instead",
        ["ใช้ไมโครโฟนไม่ได้"] = "Cannot use the microphone",
        ["เสียงสั้นเกินไป"] = "Too short",
        ["กดค้างไว้แล้วพูด ปล่อยเพื่อส่ง"] = "Hold the button and talk, release to send",
        ["ปล่อยเพื่อส่ง · เลื่อนออกเพื่อยกเลิก"] = "Release to send · slide away to cancel",
        ["กดไมค์อีกครั้งเพื่อหยุด · Esc ยกเลิก"] = "Tap the mic again to stop · Esc cancels",
        ["ข้อมูล"] = "Info",
        ["ตัวละคร"] = "Character",
        ["ค้นหา"] = "Search",
        ["กลับ (ปิด Chat setting)"] = "Back (close Chat setting)",
        ["ย่อ ▴"] = "Fold ▴",
        ["ย่อกลับ"] = "Fold back",
        ["🧍 ตัวละคร: เปิด"] = "🧍 Character: on",
        ["🧍 ตัวละคร: ปิด"] = "🧍 Character: off",
        ["เปิด/ปิดตัวละครบนหน้าแชต"] = "Show or hide the character on the chat screen",
        ["ซ่อนตัวละคร (ดูข้อความได้เต็มที่)"] = "Hide the character (see more of the chat)",
        ["แสดงตัวละคร"] = "Show the character",
        ["⌕ ค้นหา"] = "⌕ Search",
        ["+ session ใหม่"] = "+ New session",
        ["แสดง prompt"] = "Show prompt",
        ["ภาษา"] = "Language",
        ["การแสดงข้อความ"] = "Messages",
        ["0 · ซ่อน"] = "0 · Hidden",
        ["ไม่แสดง chat bubble"] = "No chat bubbles",
        ["1 · ล่าสุด"] = "1 · Latest",
        ["แสดง 2 ข้อความล่าสุด"] = "The two newest messages",
        ["2 · ปกติ"] = "2 · All",
        ["แสดงข้อความทั้งหมด"] = "All messages",
        ["พิมพ์ข้อความ…"] = "Type a message…",
        ["แตะ = ถ่ายรูป · กดค้าง = เลือกไฟล์"] = "Tap = camera · hold = choose a file",
        ["ตำแหน่งตัวละคร (3D)"] = "Character position (3D)",
        ["ตำแหน่งตัวละคร (2D)"] = "Character position (2D)",
        ["หมุน"] = "Turn",
        ["ก้ม / เงย"] = "Tilt",
        ["ซูม"] = "Zoom",
        ["ขยาย"] = "Size",
        ["ซ้าย - ขวา"] = "Left - right",
        ["ลง - ขึ้น"] = "Down - up",
        ["รีเซ็ตตำแหน่ง"] = "Reset position",
    };
}
