# PLC-Sheets

This is an application meant to basically be a clone of Excel that can open Excel spreadsheets (.xls, .xlsx, .xlsm, and .csv because why not) but can talk to PLC's inline within the cells

App is based on nodejs + electron and uses w2ui for much of the interface (see example.html for demo from the w2ui website of a grid interface like I want)

For now, consider Modbus TCP communication only, but leave affordance for Modbus Serial in the future

For now, only consider these basic excel functions:
* Arithmetic
* String functions / concatenation
* VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH
* Cell references
* Any trivial functions I may have missed
* Comments (read and write if possible)
* Formatting (read and write if possible)
* Conditional formatting (read and write if possible)

DO NOT IMPLEMENT (but do NOT strip):
* Macros
* Any External Data including workbook references
* DDE formulas

Any cells with unsupported formulas will gracefully show an error much like excel (#NAME?) and will NOT be overwritten

The app supports Saving back as a workbook

NOTE: I've used the xlsx package before and IMO it was extremely robust

## Modbus Configuration
### Server Settings
* One or two servers can be configured, with parameters:
  * Name - an arbitrary name to refer to (alphanumeric w/ hypen and underscore, no spaces)
  * IP address
  * Device ID
  * Zero-based/one-based addressing
  * any other relevant configuration supported by the driver

### Interface Settings
The "interface" sits between the server(s) and the user space. There is exactly **one** interface configured at any time — it is the implicit target of every MODBUS_* formula (no per-formula source argument). The interface owns its own redundancy configuration: pick a single server (no redundancy) or a primary + secondary server pair plus a failover policy. The interface mimics as many different configurations of an industrial DCS as possible, including but not limited to:
* Primary server (required) - chosen from the configured Servers
* Secondary server (optional) - when set, the interface operates as a redundant pair (primary = "A", secondary = "B"). The pair is referred to by the interface's name.
* Failover policy (only when a secondary is set):
  * Manual selection (via button quickly and easily accessible when using the app)
  * Periodic swap
  * Primary/Standby w/ heartbeat address (if configured address value doesn't change for n seconds failover to standby). Heartbeat can be an incrementing register or a flip flop coil
  * Warn on read mismatch after n seconds
* Heartbeat write (writes incrementing register or flip flop coil every n seconds)
* Setting for 0-15 or 1-16 bit nomenclature as well as 15-0 or 16-1 for reverse (15/16 = LSB)
* settings for byteswap and wordswap (for 32 bit types)
* Read polling (how to configure the multi-register reads)
  * Base poll rate: n seconds (time between re-reading same block, blocks are always queued to evenly distribute their poll requests)
  * Minimum time between requests
  * Block Configuration:
    * Auto (automatically determined based on usage, attempt to optimize for gaps)
      * Maximum block size
      * Minimum block size
      * Maximum number of blocks
    * Uniform (blocks of block size start at an integer multiple of block size plus offset)
      * Block size
      * Offset
    * Manual (blocks are manually input by the user into a grid -OR- any generated blocking can be converted to Manual for later tweaking)
    * None (individual single-address commands only)
    * (separate setting) Allow Individual Reads yes/no - allows individual commands if not captured in blocking, or if set to Auto can be used to read certain registers faster than the rest of their block if optimal.
    NOTE: Any operation on a coil or register not present in a block or allowed by the Individual Reads setting errors on the cell and only prints a SINGLE event in the log (do not flood). The event will only return if the log is cleared with a user-accessible Clear button
    * Slow Polling Max Rate in seconds - if the server has faulted then incrementally roll back the poll rate until this rate is reached. Throw a warning if slow polling has started and throw an error if maximum slow polling is reached
* Write polling:
  * Write on change or always write (every n seconds)
  * Write until matching readback every n seconds until x retries
  * If always write, then offer Blocking settings (same basket of settings as read polling)
* Any others you can think of

Any and all modbus errors or warnings go to a user log available in the frontend

All configuration settings are saved to a JSON file for retention and can be exported or imported through the app

## Modbus Usage
We simply shim in some pseudo-functions in the form of:
=MODBUS_READ_REGISTER(address, datatype["int16"|"uint16"|"int32"|"uint32"|"float32"|"ascii"], poll_rate in integer seconds (0 for as fast as possible, -1 for base rate))
=MODBUS_READ_COIL(address, bit_number (-1 to discern from address), poll_rate in integer seconds (0 for as fast as possible, -1 for base rate))
=MODBUS_WRITE_REGISTER(reference[cell], ...same from MODBUS_READ_REGISTER function, optional readback address (uses same as inline if omitted))
=MODBUS_WRITE_COIL(reference[cell], ...same from MODBUS_READ_COIL function, optional readback address (uses same as inline if omitted))

NOTES on arguments:
* All MODBUS_* formulas implicitly target the single configured interface (see Interface Settings). There is no per-formula source/server argument.
* `datatype` and `poll_rate` are optional. When omitted they default to `"int16"` and `-1` (base poll rate) respectively.
* `datatype` is **only** valid for MODBUS_READ_REGISTER / MODBUS_WRITE_REGISTER. The COIL functions never take a datatype argument.
* The formula bar provides inline autocomplete for these function names plus a parameter hint while typing.

NOTE: the WRITE functions' readback will obey the "read polling" configuration and contribute to its blocking scheme. If set to no readback with -1 will just display SUCCESS or FAILURE of the write. the SUCCESS/FAIlURE state will also style the cell green or red regardless of if readback is on or off.

NOTE: the non-existence of these formulas in excel is not a concern for us, save it back to the output worksheet as-is.

Note on the usage of "bit" - this is exclusive to the other types and requires either a coil type or a register plus the optional bit number or a register formatted as "address.n" or "address bit n" or "address:n" where n is the bit number (of the 16bit register) and the optional bit parameter is left off (warn in cell if both are present).

## Layout
The default "File Edit ..." toolbar of the Electron front-end is permanently hidden.

We have a top title bar in the HTML interface that displays the filename of the spreadsheet file opened (plus date modified of that file which updates on save operation) as well as Open, Save, and Save As buttons

There is then a toolbar on the left and the body on the right. The toolbar is resizable and includes:
* Server Settings
* Interface Settings
* Filename of opened file (if successfully opened)
  * Sheets of that file (or "contents" if CSV was opened)
