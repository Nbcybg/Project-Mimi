using Mimi.Core.Hub;

namespace Mimi.Core.Tests;

/// <summary>The language of the app (the web's i18n.js) and the settings as the web's menu of nine cards.</summary>
public sealed class SettingsAndLanguageTests
{
    [Fact]
    public void Thai_is_the_default_and_english_covers_what_the_web_translated()
    {
        Loc.Set("th");
        Assert.Equal("th", Loc.Language);
        Assert.Equal("แชต", Loc.T("แชต"));
        try
        {
            Loc.Set("en");
            Assert.Equal("en", Loc.Language);
            // The web's table (packages/ui/i18n.js): 'you', 'chat.default', 'copy.done', 'top.info'.
            Assert.Equal("You", Loc.T("คุณ"));
            Assert.Equal("Chat", Loc.T("แชต"));
            Assert.Equal("Info", Loc.T("ข้อมูล"));
            // A text the web has not translated stays Thai, as on the web ("a half-translated screen still works").
            Assert.Equal("ข้อความที่ไม่มีใครแปล", Loc.T("ข้อความที่ไม่มีใครแปล"));
        }
        finally
        {
            Loc.Set("th");
        }
    }

    [Fact]
    public void An_unknown_language_is_thai_and_a_change_is_announced_once()
    {
        Loc.Set("th");
        var changes = 0;
        void Count() => changes++;
        Loc.Changed += Count;
        try
        {
            Loc.Set("th");
            Assert.Equal(0, changes);
            Loc.Set("en");
            Assert.Equal(1, changes);
            Loc.Set("fr");
            Assert.Equal("th", Loc.Language);
            Assert.Equal(2, changes);
        }
        finally
        {
            Loc.Changed -= Count;
            Loc.Set("th");
        }
    }

    [Fact]
    public void Settings_are_the_webs_nine_pages_in_its_order()
    {
        Assert.Equal(
            ["account", "profile", "prefs", "appearance", "memory", "providers", "defaults", "system", "backup"],
            Catalog.SettingsTabs.Select(tab => tab.Key).ToArray());
        Assert.Equal(
            ["บัญชีและเซิร์ฟเวอร์", "โปรไฟล์ของฉัน", "งบประมาณและการแจ้งเตือน", "หน้าตาและภาษา", "ความจำ", "ผู้ให้บริการโมเดล", "โมเดลเริ่มต้นและระบบ", "พื้นที่เก็บข้อมูลและการเชื่อมต่อ", "สำรอง / กู้คืนข้อมูล"],
            Catalog.SettingsTabs.Select(tab => tab.Label).ToArray());
        // Every page has words under its name, and no list is on two pages.
        Assert.All(Catalog.SettingsTabs, tab => Assert.NotEmpty(tab.Lead));
        var lists = Catalog.SettingsTabs.SelectMany(tab => tab.Lists.Select(list => list.Key)).ToList();
        Assert.Equal(lists.Count, lists.Distinct().Count());
    }

    [Fact]
    public void A_single_object_with_fields_and_a_save_is_what_the_page_shows_as_a_form()
    {
        // These are drawn as a form in the page (profile, budget, defaults); the rest are lists or buttons.
        foreach (var def in new[] { Catalog.Profile, Catalog.Preferences, Catalog.General })
        {
            Assert.True(def.Single);
            Assert.NotNull(def.Save);
            Assert.NotEmpty(def.Fields!);
        }
        // The gateway account is only buttons: nothing to open, no row.
        Assert.Empty(Catalog.GatewayAccount.Fields!);
        Assert.Null(Catalog.GatewayAccount.Save);
        Assert.All(Catalog.GatewayAccount.Actions!, action => Assert.False(action.ForItem));
    }
}
