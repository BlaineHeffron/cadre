---
description: REA guide for native binaries, managed assemblies, archives, and extraction.
---

<!--
Copyright (c) 2026 morluto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->

# Native, managed, and packaged artifacts

## Engine-free format inspectors

These take an explicit local path, need no `open_binary`, engine, or target
execution, and most accept `detail: "summary"` with retained
`inspect_analysis_view` pages. Pick the one matching the supplied file from the
connected tool list:

- Go build/module metadata `inspect_go_binary` (`include_string_literals: true`
  recovers bounded static `(ptr, len)` strings, not inlined ones); Rust cargo-auditable crates
  `inspect_rust_binary`; Unity `global-metadata.dat` `inspect_il2cpp_metadata`.
- PE: `inspect_pe_imports`, `inspect_pe_certificates` (signatures not verified),
  `inspect_pe_load_config` (TLS callbacks, CFG), `inspect_pe_resources`;
  Windows `.lnk` shortcuts `inspect_windows_shortcut`.
- ELF: `inspect_elf_notes`, `inspect_kernel_module`, `inspect_binary_layout`
  (caller-supplied pwntools), `inspect_recorded_crash` (x86-64 core),
  `inspect_elf_unwind_ranges` (function ranges that survive `strip`),
  `inspect_kernel_build_config` (kernel banner and embedded `CONFIG_*`; xz/lz4/
  zstd payloads need external decompression first).
- ELF/PE/Mach-O: `inspect_binary_hardening` (PIE, NX, RELRO, canaries;
  signature rows report presence, not validity), `inspect_native_initializers`
  (functions run before `main` or at exit; keep each entry's `resolution`).
- Shipped `.app`, install dir, ASAR, or executable: `audit_release_exposure`
  reports what static analysis recovers; it does not establish security.
- PE/ELF exports `inspect_native_exports`; Mach-O `inspect_macho` (use summary,
  then `view: {kind: "macho", facet: "exports", ...}` on large frameworks).
- Other formats: `inspect_python_pyc`, `inspect_erlang_beam`,
  `inspect_wasm_artifact`, `inspect_sqlite_database`, `inspect_model_artifact`
  (GGUF/safetensors), `inspect_apk_signature`, `inspect_evm_interface`,
  `inspect_apple_ips` (`join_path` matches images to one Mach-O/dSYM by UUID),
  `inspect_desktop_application` (unknown install dirs).
- Apple app resources: `open_bundle_resources`, then `inspect_plist`,
  `decode_interface_builder`, `inspect_asset_catalog`, or `inspect_keyed_archive`.

A missing table or section is observed absence of that declaration, not proof
the artifact never carried it. Declared metadata is not authenticated, and
recovered identities stay scoped to the artifact SHA-256.

## Native targets

After `open_binary`, use focused search, procedure, or function tools directly.
Use `binary_overview` when metadata or inventory context helps. Prefer literal
search, names, decompilation, callers, callees, and cross-references. Addresses
and pseudocode are analysis observations, not original source. Provider
unavailability and unsupported metadata remain unknown rather than false.

Over MCP, `analyze_function` replies with a summary; its
`normalized_result.parent_evidence_id` is the retained dossier. Page facets with
`view: {kind: "native", facet: "value_flow_operations", offset: 0, limit: 32}`
(also pseudocode, assembly, basic blocks, callers/callees, references, strings).
Null counts mark facets the provider did not record. For large pseudocode, call
`procedure_pseudo_code` with `detail: "summary"` and page facet `pseudocode`
(offsets count UTF-16 units; follow `coverage.next_offset`). `get_call_graph`,
callers/callees, and `resolve_containing_procedure` also accept summary, paging
`native-observation` and `native-context` views from the parent Evidence ID.

`binary_session` with `{}` returns a compact summary: the open target, selected
provider, and `result.tool_availability` grouped by status (expand each group's
`names`, inheriting inventory-level requirements unless overridden).
`omitted_fields` lists what is left out; `{"detail": "complete"}` adds
remediation, candidate capabilities, and effect/annotation flags (listed flags
true, omitted known flags false). `analysis_provider_binding` names the
selected provider.

For release comparisons on one MCP connection, retained `list_procedures`
Evidence IDs survive target switches and `close_binary`; for a new process,
export the complete bundle (with its source closure) and import it there.
`reset_investigation` clears retained records (optional `save_path` first). Then
`match_native_functions` (unique exact names, optional body bytes); pass an
`analyze_function` summary as its `parent_evidence_id` reference. Unpaired
observations do not prove additions or removals; analyze only the chosen pairs
with `compare_functions`, then aggregate by exact `retained-evidence` IDs with
`find_changed_behavior` (static differences stay behavior candidates). On a
matching representation refusal, raise `native.matching_representation_bytes`
(default 96 MiB) per `details.limit` and retry unchanged; do not split
inventories, which changes name/body uniqueness.

Ghidra: a first-query `provider_timeout` covers import and auto-analysis
(default 330000 ms); when the error names `ghidra.startup_timeout_ms` or
`ghidra.decompile_timeout_seconds`, raise it with `update_analysis_settings` and
retry. A timeout never establishes absence of code. `read_bytes` reads
initialized analysis memory, not a running process; check `returned_bytes` and
`complete`, and never zero-fill an incomplete read. `address_to_file_offset`
anchors one address, not a whole table; loader fixups can differ from file bytes.

Ghidra edits are ephemeral unless `REA_GHIDRA_CHECKPOINT_DIR` (a private absolute
directory) was set when REA started; then opens restore compatible saved
Programs and `close_binary` saves edits. `binary_session` capability
`shared_limitations` says which mode is active; do not assume a restore
happened. To reuse a caller's project, set `REA_GHIDRA_PROJECT_PATH` (`.gpr`)
and optionally `REA_GHIDRA_PROGRAM_NAME`, then restart; REA opens a read-only
verified copy, so edits are unavailable and prior analysis completeness is
unknown.

## DOS MZ, COM, and raw images

For an admitted DOS MZ target, use `inspect_native_load_image` to check loaded
bytes, file mappings, relocations and the entry; keep `mismatch` and
`unsupported` explicit. Large reports take `detail: "summary"` and page
`native-load-image` collections. Headerless DOS COM opens with `format: "dos-com"`.
Other headerless firmware opens with `format: "raw-binary"`, `architecture`, and
`entry_point` (Ghidra only). Ghidra pseudocode also accepts
`procedure: "file-offset:0x..."`; never assume an offset plus image base is an
analysis address. Function body ranges use inclusive ends and can contain gaps.
For packed targets, retain both identities; decompiling an unpacking stub does
not recover the unpacked program.

## Managed PE/CLI

Start with `inspect_managed_artifact`; it is execution-free, so never claim it
loaded, reflected, executed, or resolved the assembly. For large assemblies use
`detail: "summary"`, then `view: {kind: "managed", collection: "attributes", ...}`
(`references`, `resources`, `attributes`). For one type, call
`inspect_managed_members` with `detail: "summary"` and `type_names`, then page
`kind: "managed-members"` collections, narrowing with exact `names` and
`declaring_types` filters (check `unresolved_filter_rows` before reading an
empty match as absence). Returned-row exhaustion does not prove
complete metadata.

### .NET NativeAOT

NativeAOT binaries contain native machine code, so CIL decompilers cannot
recover method bodies. When managed metadata is absent, route to native analysis
rather than claiming source recovery, and describe output as pseudocode. Identify
images (PE, ELF, or Mach-O) by bytes and loader metadata, not suffixes. REA has
a built-in read-only parser for x64 PE with .NET 8 RTR 9.1 metadata; read frozen
literals from its report, since `search_strings` omits them. Recovered types are
not original C# source.

## Packages and extraction

Use `inspect_artifact` for bundles, archives, ZIP/APK/IPA/MSIX/AppX, ASAR, DMG,
PyInstaller executables, Godot PCK, UnityFS AssetBundles, WeChat `.wxapkg`,
U-Boot uImage, classic iNES, ESP32 app/flash images, Bun `--compile` and
`deno compile` executables when the graph and findings help; request
`detail: "summary"` for large inventories and cite graph manifest IDs. For an
IPA or macOS `.app`, `project_apple_application_graph` reports nested bundles by
path convention (read the listed plists to confirm), and `trace_dylib_resolution`
follows `@rpath` loads after `open_binary`. Route JavaScript extracted from
Bun or Deno executables to `analyze_javascript_application`; bytecode and
encrypted payloads (wxapkg `V1MMWX`, encrypted UnityFS) are not decoded, and
iNES PRG/CHR units are not mapper bank maps.

`extract_artifact` materializes the active target's regular files into a fresh
REA-chosen temporary directory; symlinks and encrypted entries stay inventory
facts. DMG extraction is unavailable, and DMG traversal mounts read-only only on
macOS. Use `inspect_byte_entropy` to triage ranges before extraction. Intel
HEX, S-record, UF2, and DfuSe are containers: extract each address region, then
open it as `raw-binary` with its start address as `entry_point`.

`annotate_native_function` (and `set_address_name`) edit the Ghidra database:
original bytes are unchanged and edits invalidate immutable snapshots. Close
saves them only in checkpoint mode; a provider switch or different target can
discard them. Batch renames that collide are rejected per address in
`raw_result.failures`. For before/after `compare_functions`, capture
`analyze_function` Evidence around the edit; renamed entries match as
`same-entry`.

<!-- upstream: morluto/rea@d74549e .agents/skills/reverse-engineer-anything/references/native-and-artifacts.md -->
