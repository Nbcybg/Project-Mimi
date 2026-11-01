import fs from 'node:fs';
import * as ResEdit from 'resedit';

/**
 * Windows shows an Electron app by the version resource inside the .exe, not by the file
 * name: a renamed electron.exe still says "Electron" in Task Manager, Alt-Tab and the
 * notification settings. Write Mimi's own identity (and icon) before signing the build.
 */
export function patchWindowsApp({ exe, icon, version, product = 'Mimi', company = 'Noobcyborg Studio', description = 'Mimi' }) {
  const executable = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);

  if (icon && fs.existsSync(icon)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icon));
    for (const group of ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)) {
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
        resources.entries,
        group.id,
        group.lang,
        iconFile.icons.map((item) => item.data),
      );
    }
  }

  const info = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0];
  if (info) {
    const parts = String(version)
      .split(/[^0-9]+/)
      .filter(Boolean)
      .slice(0, 4)
      .map(Number);
    while (parts.length < 4) parts.push(0);
    const language = typeof info.lang === 'number' ? info.lang : 1033;
    info.setFileVersion(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0, language);
    info.setProductVersion(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0, language);
    info.setStringValues(
      { lang: language, codepage: 1200 },
      {
        FileDescription: description,
        ProductName: product,
        CompanyName: company,
        LegalCopyright: `Copyright (C) ${new Date().getFullYear()} ${company}. All rights reserved.`,
        OriginalFilename: `${product}.exe`,
        InternalName: product,
        FileVersion: String(version),
        ProductVersion: String(version),
      },
    );
    info.outputToResourceEntries(resources.entries);
  }

  resources.outputResource(executable);
  fs.writeFileSync(exe, Buffer.from(executable.generate()));
}

/** `node scripts/patch-exe.mjs <exe> <ico> <version>` for a build made by hand. */
if (process.argv[1] && process.argv[1].endsWith('patch-exe.mjs') && process.argv.length >= 5) {
  patchWindowsApp({ exe: process.argv[2], icon: process.argv[3], version: process.argv[4] });
}
