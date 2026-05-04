# History timestamps of modbus data

The current approach (revised plan note)

Option A is the right call for initial implementation. The recomputeStartTime approach is well within the accuracy requirements of any historian running at 250ms–1s poll rates, and it degrades gracefully.

Option B (AST walk) as a future enhancement — it is actually feasible because the ast argument in every HF plugin does carry the original argument AST nodes, and for a direct cell reference (arg[1] written as B4) the AST node would be an AddressCellAst. You could walk it to recover the sheet/row/col, then look up modbusManager's cache timestamp for whatever Modbus address that cell evaluated. This would give true sub-poll-cycle precision, but it's non-trivial and not needed in Phase 1.