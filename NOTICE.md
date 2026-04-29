# Third-Party Notices

PLC-Sheets bundles or links against the following open-source components.
Each retains its original license. The complete list with versions is
available in `package-lock.json`.

| Component        | License        | Source                                              |
| ---------------- | -------------- | --------------------------------------------------- |
| HyperFormula     | GPL-3.0        | https://hyperformula.handsontable.com/              |
| ExcelJS          | MIT            | https://github.com/exceljs/exceljs                  |
| SheetJS (xlsx)   | Apache-2.0     | https://sheetjs.com/                                |
| modbus-serial    | MIT            | https://github.com/yaacov/node-modbus-serial        |
| w2ui             | MIT            | https://w2ui.com/                                   |
| Electron         | MIT            | https://www.electronjs.org/                         |
| electron-store   | MIT            | https://github.com/sindresorhus/electron-store      |
| Zod              | MIT            | https://zod.dev/                                    |

## HyperFormula GPL-3.0 implications

The bundled HyperFormula uses the community GPL-3.0 license key. Because
PLC-Sheets links HyperFormula at runtime, distributions of PLC-Sheets are
governed by GPL-3.0 unless a commercial HyperFormula key has been provisioned.

If you intend to ship PLC-Sheets under a different license (proprietary,
internal-use-only, etc.), obtain a commercial HyperFormula license from
Handsontable and replace the `licenseKey: 'gpl-v3'` reference in
`src/main/formula/host.ts` with the provided key.
