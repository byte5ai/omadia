# Changelog

All notable changes to omadia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.0](https://github.com/byte5ai/omadia/compare/omadia-v0.2.0...omadia-v0.3.0) (2026-06-05)


### Features

* **auth:** OB-61 — collect anthropic_api_key in setup wizard, drop ENV requirement ([#155](https://github.com/byte5ai/omadia/issues/155)) ([65316ed](https://github.com/byte5ai/omadia/commit/65316ed00798bf289835353f7f1f0204edd3f7cc))
* **builder:** activate sycophancy-guard compile pipeline ([#51](https://github.com/byte5ai/omadia/issues/51)) ([#62](https://github.com/byte5ai/omadia/issues/62)) ([14bed20](https://github.com/byte5ai/omadia/commit/14bed20fa404d0f38e8bab270f929bbe8f42e1bd))
* **builder:** add read_slot tool (closes [#99](https://github.com/byte5ai/omadia/issues/99)) ([#104](https://github.com/byte5ai/omadia/issues/104)) ([45cb340](https://github.com/byte5ai/omadia/commit/45cb34028e91384f286bd202b09b79543073488c))
* **builder:** audit log backend — schema + tools + API ([#56](https://github.com/byte5ai/omadia/issues/56)) ([#66](https://github.com/byte5ai/omadia/issues/66)) ([84e9252](https://github.com/byte5ai/omadia/commit/84e92523b05a5091f9fec632b73e21253119ffcb))
* **builder:** audit timeline UI ([#57](https://github.com/byte5ai/omadia/issues/57)) ([#67](https://github.com/byte5ai/omadia/issues/67)) ([39c9256](https://github.com/byte5ai/omadia/commit/39c9256b2305c7d3211452f453b39afc2007abd0))
* **builder:** boundary preset library + section UI ([#54](https://github.com/byte5ai/omadia/issues/54)) ([#63](https://github.com/byte5ai/omadia/issues/63)) ([d4ff178](https://github.com/byte5ai/omadia/commit/d4ff1781b61376c56c4e73e54d7c85c4cc265af3))
* **builder:** culture presets — 6 industry overlays ([#59](https://github.com/byte5ai/omadia/issues/59)) ([#65](https://github.com/byte5ai/omadia/issues/65)) ([9463d68](https://github.com/byte5ai/omadia/commit/9463d6871b2b1a4883339c2ae76a388bce32b381))
* **builder:** live persona/quality/sycophancy in preview chat ([#85](https://github.com/byte5ai/omadia/issues/85)) ([d91e911](https://github.com/byte5ai/omadia/commit/d91e9112b384c68c0518d907ffb237a8212df5bf))
* **builder:** multi-family persona baselines data asset ([#58](https://github.com/byte5ai/omadia/issues/58)) ([#64](https://github.com/byte5ai/omadia/issues/64)) ([1a6c7c2](https://github.com/byte5ai/omadia/commit/1a6c7c2983a3a5186a0d306d9689c651591327a0))
* **builder:** native issue reporting + workaround tracking ([#101](https://github.com/byte5ai/omadia/issues/101)) ([0bada23](https://github.com/byte5ai/omadia/commit/0bada2349ac2b175059291d0ead23945e2de2b12))
* **builder:** PATCH /drafts/:id/{persona,quality} with tool roundtrip ([#53](https://github.com/byte5ai/omadia/issues/53)+[#54](https://github.com/byte5ai/omadia/issues/54) follow-up) ([#73](https://github.com/byte5ai/omadia/issues/73)) ([d9be206](https://github.com/byte5ai/omadia/commit/d9be2069dc09fcded4f95d58bba7f7de38e72c8a))
* **builder:** persona templates + gallery (6 archetypes) ([#53](https://github.com/byte5ai/omadia/issues/53)) ([#68](https://github.com/byte5ai/omadia/issues/68)) ([195f07a](https://github.com/byte5ai/omadia/commit/195f07a01801f9fc31efcde119971b18efbc34b6))
* **builder:** preview reads through to live ServiceRegistry (test integration-backed agents) ([#199](https://github.com/byte5ai/omadia/issues/199)) ([21ad66f](https://github.com/byte5ai/omadia/commit/21ad66f893db00c6da8b8f4cf798c698ee8197c2))
* **builder:** preview-prompt panel (live compiled system-prompt) ([#55](https://github.com/byte5ai/omadia/issues/55)) ([#69](https://github.com/byte5ai/omadia/issues/69)) ([cab91f7](https://github.com/byte5ai/omadia/commit/cab91f7b6d085b1f3a71a11f9f6ac8f837399c70))
* **builder:** quality-score engine + panel ([#52](https://github.com/byte5ai/omadia/issues/52)) ([#70](https://github.com/byte5ai/omadia/issues/70)) ([6b4f838](https://github.com/byte5ai/omadia/commit/6b4f83820e7a33d6e59a7a4c0b992910926023b6))
* **builder:** service-type auto-discovery for integration-backed agents ([#196](https://github.com/byte5ai/omadia/issues/196)) ([8d6d393](https://github.com/byte5ai/omadia/commit/8d6d393c924d890600b782dd18ed79292945fb65))
* **builder:** simplified No-Code view + full builder i18n ([#210](https://github.com/byte5ai/omadia/issues/210)) ([527d299](https://github.com/byte5ai/omadia/commit/527d29919b4167e5e8807eff88fe800e0c6ebfcf))
* **channel-sdk:** additive Omadia UI canvas interface surface ([#167](https://github.com/byte5ai/omadia/issues/167)) ([8d0034c](https://github.com/byte5ai/omadia/commit/8d0034c750e113353a83f010eee4cc8caafa0adf))
* **channel-sdk:** WebSocket transport for channel plugins (Omadia UI canvas) ([#205](https://github.com/byte5ai/omadia/issues/205)) ([fc12ceb](https://github.com/byte5ai/omadia/commit/fc12ceba7ed9abd3210fe89f0ff00cd529c706be))
* **channels:** per-binding agent routing + channelType autodiscovery (US7) ([#200](https://github.com/byte5ai/omadia/issues/200)) ([41e2527](https://github.com/byte5ai/omadia/commit/41e25273fd575f6391e759b346eceeb99a954b27))
* **channels:** per-channel dispatch_service routing (Omadia UI) ([#168](https://github.com/byte5ai/omadia/issues/168)) ([5aaa55b](https://github.com/byte5ai/omadia/commit/5aaa55bf122aa9ff26e13629808bcc3c254129d6))
* **channels:** wire handleTurnStream to the orchestrator + getChatAgent SDK helper ([#165](https://github.com/byte5ai/omadia/issues/165)) ([7da31ba](https://github.com/byte5ai/omadia/commit/7da31ba6a36ab3f279cd82d65d4f686c8c427832))
* **chat:** stream survives tab/menu switch + composer reset + background toasts ([#145](https://github.com/byte5ai/omadia/issues/145)) ([86389ac](https://github.com/byte5ai/omadia/commit/86389ac8d36a07ebe93e8050dec81799ec0c51c8))
* consolidate workshop changes since v0.1.0 (single-repo migration) ([1307df1](https://github.com/byte5ai/omadia/commit/1307df1facbfcb2b15eed7c42f2c9a78256ce393))
* consolidate workshop changes since v0.1.0 (single-repo migration) ([0a9819d](https://github.com/byte5ai/omadia/commit/0a9819d671973395e7d451cd8264a0e5ac7caaec))
* initial public release (Omadia v0.1.0) ([65a70d5](https://github.com/byte5ai/omadia/commit/65a70d53eadf11e01002a2037cc09bcd6a8d3ea1))
* multi-orchestrator runtime (US1–US9) + Phase A chat routing + Phase B operator UX ([#146](https://github.com/byte5ai/omadia/issues/146)) ([8e387cb](https://github.com/byte5ai/omadia/commit/8e387cb8b0693f99ac647c8c4f5997db473169b2))
* **no-reply:** silence sentinel for routine + chat outputs ([b2c659d](https://github.com/byte5ai/omadia/commit/b2c659dba028355a734fdc1ca4bb6e498b51900d))
* **office:** headless Office — deterministic .xlsx/.docx generation + multi-channel delivery ([#161](https://github.com/byte5ai/omadia/issues/161)) ([b354741](https://github.com/byte5ai/omadia/commit/b35474189494450336df42ec0bff036945d5ac6a))
* **operator/channels:** A+B — channel-key directory + dashboard ([#148](https://github.com/byte5ai/omadia/issues/148)) ([51ae141](https://github.com/byte5ai/omadia/commit/51ae1412b47a39e7c86615c8c4f4e3199bc05643))
* **orchestrator:** canvas sentinel parsers + canvas-output gate ([#169](https://github.com/byte5ai/omadia/issues/169)) ([45721b6](https://github.com/byte5ai/omadia/commit/45721b6c43b0e776f239a07faa8cbdff846a0a92))
* **orchestrator:** cross-session KG-recall probe (plans, processes, team insights) ([#189](https://github.com/byte5ai/omadia/issues/189)) ([43380fa](https://github.com/byte5ai/omadia/commit/43380fa8bbd8a2adc7eabbea866b9a2dd4f0696c))
* **orchestrator:** plan-as-data foundations ([#133](https://github.com/byte5ai/omadia/issues/133), slices E0–E5) ([#188](https://github.com/byte5ai/omadia/issues/188)) ([ce67c40](https://github.com/byte5ai/omadia/commit/ce67c40c9c36b764741ecb5cb25d9d0eff488d80))
* **orchestrator:** strict per-orchestrator memory + Knowledge-Graph isolation ([#201](https://github.com/byte5ai/omadia/issues/201)) ([624f1a0](https://github.com/byte5ai/omadia/commit/624f1a0a38aceb24b3d1427126a99661698a65dd))
* **plugin-api:** structured? output + writeCapabilities contract ([#170](https://github.com/byte5ai/omadia/issues/170)) ([6848b7c](https://github.com/byte5ai/omadia/commit/6848b7c1820ea91b09b7e84be4a9864d73d08bdf))
* **plugin-api:** widen EntityRef.op to 'read' | 'write' ([#193](https://github.com/byte5ai/omadia/issues/193)) ([c0b1b29](https://github.com/byte5ai/omadia/commit/c0b1b29b10ae439a0d06080342d36590e090a464))
* **plugins:** dynamic host allowlist for audit plugins ([#113](https://github.com/byte5ai/omadia/issues/113)) ([50b9d5a](https://github.com/byte5ai/omadia/commit/50b9d5abf47ae51a809f7e9891fcf4fba9f1e2d0))
* **plugins:** localized third-party setup guides (setup.guide) ([#191](https://github.com/byte5ai/omadia/issues/191)) ([063132c](https://github.com/byte5ai/omadia/commit/063132c1f3fe3dd0a4d9a88da152efd2175c9d1b))
* **privacy-guard:** stable-id tokenization — complete (Slices 1-3) ([#86](https://github.com/byte5ai/omadia/issues/86)) ([3142d25](https://github.com/byte5ai/omadia/commit/3142d256ba8298150555a199f74609a5c4e1be7b))
* **privacy:** operator-owned per-plugin Privacy Mode (Slice 2.5) ([#153](https://github.com/byte5ai/omadia/issues/153)) ([2a19fec](https://github.com/byte5ai/omadia/commit/2a19fec13077dfdcb7ede60d4a7b7e55b75ac4ea))
* **registry:** plugin store MVP — admin-managed remote registries, remote install + depends_on chaining ([#162](https://github.com/byte5ai/omadia/issues/162)) ([cf31656](https://github.com/byte5ai/omadia/commit/cf316569f67a9e86eb621c252175dc118596369d))
* **registry:** update detection + store-card update Störer ([#163](https://github.com/byte5ai/omadia/issues/163)) ([e1ee381](https://github.com/byte5ai/omadia/commit/e1ee38104a13f1f24a5d985ecff40ca60375d74d))
* **ui-channel:** canvas WebSocket transport (handshake + turn + surface fan-out) ([#209](https://github.com/byte5ai/omadia/issues/209)) ([fa55597](https://github.com/byte5ai/omadia/commit/fa55597edad5eac05039e9740ab79e44f74a61af))
* **ui-channel:** skeleton channel plugin (canvas surface) ([#173](https://github.com/byte5ai/omadia/issues/173)) ([d449179](https://github.com/byte5ai/omadia/commit/d449179e461c00ce20908af2b53cf42168e16e56))
* **ui-orchestrator:** skeleton plugin publishing canvasChatAgent@1 ([#171](https://github.com/byte5ai/omadia/issues/171)) ([0f6dab8](https://github.com/byte5ai/omadia/commit/0f6dab8b6d6a255bcb13ed9d68495459c71a152c))
* **verifier:** [#130](https://github.com/byte5ai/omadia/issues/130) tool-output postcondition validation + retry ([#157](https://github.com/byte5ai/omadia/issues/157)) ([01151f4](https://github.com/byte5ai/omadia/commit/01151f4ffa1f0cb0ef6bfca7e3d8f6bb7e19a9e7))
* **verifier:** [#131](https://github.com/byte5ai/omadia/issues/131) citation enforcement for KG-grounded answers ([#159](https://github.com/byte5ai/omadia/issues/159)) ([66f3363](https://github.com/byte5ai/omadia/commit/66f336378dc86f6175db7c10c2330149131f9732))
* **verifier:** [#132](https://github.com/byte5ai/omadia/issues/132) confidence-gated re-sampling on borderline verdicts ([#160](https://github.com/byte5ai/omadia/issues/160)) ([c6ab0f8](https://github.com/byte5ai/omadia/commit/c6ab0f8378436f9e1e6d513bef44403f6228b1ec))
* **web-ui:** visible session-expiry handling (warning + auto-logout) ([#116](https://github.com/byte5ai/omadia/issues/116)) ([9c11989](https://github.com/byte5ai/omadia/commit/9c1198933e83f455f070c99afd89c1694fe1e5b6))


### Bug Fixes

* **bootstrap/telegram:** redact admin token from logs ([09b6161](https://github.com/byte5ai/omadia/commit/09b6161759d3598a591b0574d02c9e93d40b2cd1))
* **builder:** AST-write network.outbound so integration-backed agents build ([#198](https://github.com/byte5ai/omadia/issues/198)) ([fe81587](https://github.com/byte5ai/omadia/commit/fe81587d8917a7418ed241d1333e7580d574b6e8))
* **builder:** dark-theme readability for kemia-port UI surfaces ([#84](https://github.com/byte5ai/omadia/issues/84)) ([311af42](https://github.com/byte5ai/omadia/commit/311af42b64ed064d44b6bd654e5c1019d9128693))
* **builder:** emit @omadia/agent-* namespace for new agents ([#117](https://github.com/byte5ai/omadia/issues/117)) ([d0baa6a](https://github.com/byte5ai/omadia/commit/d0baa6aa445ba221b0d10ed6eebfe5003f81b38e))
* **builder:** IMPORT_FORBIDDEN false-positive on JSDoc import samples ([eda6cba](https://github.com/byte5ai/omadia/commit/eda6cba67a0db4c5202a0a713e2f1e7becd1251f))
* **builder:** install diff no longer crashes on drafts with missing skeleton arrays ([#96](https://github.com/byte5ai/omadia/issues/96)) ([b89ab36](https://github.com/byte5ai/omadia/commit/b89ab368da4e23ba32602740293597f897bd0595))
* **builder:** install no longer aborted by debounced preview rebuild ([106428e](https://github.com/byte5ai/omadia/commit/106428ee079e7951f3279dcb868cbb29b0bab67c))
* **builder:** install no longer aborted by debounced preview rebuild ([fec34d9](https://github.com/byte5ai/omadia/commit/fec34d914839789dbc20704fee289a80e7f4dff1))
* **builder:** install no longer aborted by debounced preview rebuild ([#49](https://github.com/byte5ai/omadia/issues/49)) ([106428e](https://github.com/byte5ai/omadia/commit/106428ee079e7951f3279dcb868cbb29b0bab67c))
* **builder:** point asset devFallback at middleware/assets after rename ([b2a7985](https://github.com/byte5ai/omadia/commit/b2a7985a1b25c2bb99ec53b57d2817b01cb5120b))
* **builder:** render ask_user_choice smart-card + default to agent-integration ([#152](https://github.com/byte5ai/omadia/issues/152)) ([dbbe030](https://github.com/byte5ai/omadia/commit/dbbe030e605b73c62104de57121864f8e6488487))
* **builder:** resolve assets and test refs after public-release rename ([5beede2](https://github.com/byte5ai/omadia/commit/5beede2f8dc7ce18727d03063e3874f4270c556c))
* **builder:** scoped plugin ids work end-to-end (preview + install + UI) ([#150](https://github.com/byte5ai/omadia/issues/150)) ([3b8764c](https://github.com/byte5ai/omadia/commit/3b8764c8ad3f06ab2013e66bb5825215313d9780))
* **builder:** show ask_user_choice pick as user-message in transcript ([#154](https://github.com/byte5ai/omadia/issues/154)) ([41b78fb](https://github.com/byte5ai/omadia/commit/41b78fb4413c2513f6997f62e532736217b873e6))
* **builder:** stop setup_field slot-fill loop (label/placeholder/help) ([#151](https://github.com/byte5ai/omadia/issues/151)) ([b7a1e98](https://github.com/byte5ai/omadia/commit/b7a1e982728dfc93629a940bdec0645fbb1674c5))
* **builder:** strip comments before import-gate regex scan ([132b78d](https://github.com/byte5ai/omadia/commit/132b78d46c45208e1774fa953e8f5e65d7159b57))
* **builder:** unblock non-search plugin specs ([#156](https://github.com/byte5ai/omadia/issues/156)) ([bfa412a](https://github.com/byte5ai/omadia/commit/bfa412a9e7d743dffdcc083f6dbc643d93bee091))
* **ci:** bump setup-node to 22 + restore omadia paths in Dockerfiles ([623eedc](https://github.com/byte5ai/omadia/commit/623eedcb63eb98c72c3d89d06bb65ea56ce24086))
* **ci:** force-install sharp linux-x64 native binary post npm-ci ([2129793](https://github.com/byte5ai/omadia/commit/212979310a646fe01312ad8131869fbb8211587d))
* **ci:** install sharp's optional linux-x64 binary ([70a9ae4](https://github.com/byte5ai/omadia/commit/70a9ae44d6a973da87eccf107dc33ef4105712ea))
* **ci:** remove smoke:privacy-v2 step — script is private (byte5-only) ([00e4194](https://github.com/byte5ai/omadia/commit/00e419423ff7d8020f63105fa86759d69ee9f9af))
* **ci:** resurrect CI after Actions reactivation ([#35](https://github.com/byte5ai/omadia/issues/35)) ([4be08c7](https://github.com/byte5ai/omadia/commit/4be08c7bddab36b47292e9f19a075ce310925fdc))
* **manifests:** use canonical key/help in setup fields so secrets render ([#123](https://github.com/byte5ai/omadia/issues/123)) ([2199f0e](https://github.com/byte5ai/omadia/commit/2199f0efcc215c2fa151db178f8dcf506d8b2e71))
* **middleware:** explicit Anthropic maxRetries=5 + log orchestrator turn failures ([#121](https://github.com/byte5ai/omadia/issues/121)) ([52dd0f5](https://github.com/byte5ai/omadia/commit/52dd0f5899713c3a6b88aa5224eb632e7b4ad02b))
* **middleware:** gate duplicate-capability installs + reconcile DEV_ENDPOINTS_ENABLED on every boot ([#115](https://github.com/byte5ai/omadia/issues/115)) ([988a3de](https://github.com/byte5ai/omadia/commit/988a3de054f2c18b5b32217c788525bc5d1e39ce))
* **no-reply:** match NO_REPLY sentinel even when appended after prose ([e5acfc6](https://github.com/byte5ai/omadia/commit/e5acfc6607c303874b52440b1eb1d022b0941864))
* **orchestrator-extras:** relevance-filter cross-session plan recall ([#190](https://github.com/byte5ai/omadia/issues/190)) ([5883de1](https://github.com/byte5ai/omadia/commit/5883de15ea2094cecf705ed57fc548d8383c4475))
* **orchestrator:** default model to claude-opus-4-7 (stale id caused 404) ([#124](https://github.com/byte5ai/omadia/issues/124)) ([78a0176](https://github.com/byte5ai/omadia/commit/78a01767088ef8b763e6e0e6fb07b7e599e9701c))
* **orchestrator:** quarantine uninstalled plugins instead of aborting registry boot ([#195](https://github.com/byte5ai/omadia/issues/195)) ([6540cce](https://github.com/byte5ai/omadia/commit/6540cce8ddd51d46c24c3c704f812b86bec359eb))
* **orchestrator:** retry mid-stream Anthropic overloaded_error ([#122](https://github.com/byte5ai/omadia/issues/122)) ([26b5baa](https://github.com/byte5ai/omadia/commit/26b5baa8ddc55f9790336db3bb82d0eb5234b7a4))
* **orchestrator:** scope per-Agent domain tools to enabled plugins ([#197](https://github.com/byte5ai/omadia/issues/197)) ([b2a3595](https://github.com/byte5ai/omadia/commit/b2a3595c1b9f53f650436368be059ab87b5ceac2))
* **plugin-manifests:** valid setup-field types + prune orchestrator-extras ([#144](https://github.com/byte5ai/omadia/issues/144)) ([d0ad74b](https://github.com/byte5ai/omadia/commit/d0ad74b01cb98af3f495d3403e4ccd127f309337))
* **plugin-upload:** kind-dispatch in onPackageReady hot-swap ([5d68e6c](https://github.com/byte5ai/omadia/commit/5d68e6cdea3086e026f98dc5d1065798a84d2819))
* **plugins:** instrument tool-bridge to surface empty Zod input schemas ([#103](https://github.com/byte5ai/omadia/issues/103)) ([3b8609f](https://github.com/byte5ai/omadia/commit/3b8609f15d8ea956befb814095a6906be4ecebdd))
* **privacy-guard:** expand "summary + detail" tool results into per-record rows ([#204](https://github.com/byte5ai/omadia/issues/204)) ([fddf86f](https://github.com/byte5ai/omadia/commit/fddf86ffa7297d72909a2f2173bfc0b17c10ebe8))
* **privacy-guard:** restore Platz/Rang/Position/Rank self-anonymization labels ([74251ac](https://github.com/byte5ai/omadia/commit/74251acb6745f116fcb6743264b3085b06e16393))
* **privacy-guard:** restore Platz/Rang/Position/Rank self-anonymization labels ([ac20146](https://github.com/byte5ai/omadia/commit/ac20146019f3740075f6d608bc03236c844d2ace))
* **privacy-guard:** trim directive to stay under 8 kB system-prompt budget ([2b1cc21](https://github.com/byte5ai/omadia/commit/2b1cc2114f39913a88f27d75cd011268f6968a73))
* **privacy-guard:** v4 — guide the LLM to render real names, not apologise ([#125](https://github.com/byte5ai/omadia/issues/125)) ([81ff7eb](https://github.com/byte5ai/omadia/commit/81ff7eb5be41253228e3b5a888c3b88b440dce04))
* **privacy:** harden outbound payload against lone UTF-16 surrogates ([#118](https://github.com/byte5ai/omadia/issues/118)) ([483ff18](https://github.com/byte5ai/omadia/commit/483ff186a751793b6337eb923f98cabad95656bf))
* **routines:** allow proactive-sender re-register on plugin hot-swap ([5c23e30](https://github.com/byte5ai/omadia/commit/5c23e300ee6926c1e3ac5307a96c5ef54b15e379))
* **secrets:** VAULT_KEY fail-hard in production, drop demo key ([60873fc](https://github.com/byte5ai/omadia/commit/60873fcf211254c1e751e43814905d3384705d1e))
* **security:** gate /api/chat/sessions behind requireAuth ([0a2d175](https://github.com/byte5ai/omadia/commit/0a2d175db78f9ccbbe2256bd7d882f9c01be0f90))
* **tests:** quote @omadia/ refs in YAML + repair stale @byte5/ test paths ([0bcb1fd](https://github.com/byte5ai/omadia/commit/0bcb1fd4aa86129a3bdea2a9fe75ae975043e359))
* **tests:** unblock 4 pre-existing failures surfaced by CI ([f962551](https://github.com/byte5ai/omadia/commit/f9625519f53d2b7227b57c17ac84752c9a8883ed))
* **web-ui:** annotate data-loading effects in graph + memory ([#108](https://github.com/byte5ai/omadia/issues/108)) ([b46e8b4](https://github.com/byte5ai/omadia/commit/b46e8b4d174eb9cf7d47301caa928c6a240a312a))
* **web-ui:** annotate fetch-on-mount effects in admin pages ([#107](https://github.com/byte5ai/omadia/issues/107)) ([60d5612](https://github.com/byte5ai/omadia/commit/60d5612cc8229a97b907c53ae800272bc91aa60f))
* **web-ui:** annotate set-state effects in builder components ([#109](https://github.com/byte5ai/omadia/issues/109)) ([3dff910](https://github.com/byte5ai/omadia/commit/3dff9103a2f232b89286ac081d88ac2bff75a638))
* **web-ui:** clear React-Compiler refs/immutability/error-boundaries warnings ([#106](https://github.com/byte5ai/omadia/issues/106)) ([be230c3](https://github.com/byte5ai/omadia/commit/be230c3fc478800459ce37e266e9662c488339cf))
* **web-ui:** finish set-state-in-effect cleanup, restore rule ([#110](https://github.com/byte5ai/omadia/issues/110)) ([a5ba73a](https://github.com/byte5ai/omadia/commit/a5ba73a45a0305298f60b0c56a69d22672f0bc0d))
* **web-ui:** hold scope chip until hydration to fix mismatch ([#105](https://github.com/byte5ai/omadia/issues/105)) ([7863b93](https://github.com/byte5ai/omadia/commit/7863b93c3f7f8020e0c41f7e89e03e14a7dc0179))
* **web-ui:** make plugin install drawer scrollable for long config forms ([#203](https://github.com/byte5ai/omadia/issues/203)) ([e1d0290](https://github.com/byte5ai/omadia/commit/e1d02901ea29f9056738eb18be3d44cef9f298c1))
* **web-ui:** pin @swc/helpers via overrides to fix dependabot lockfiles ([#178](https://github.com/byte5ai/omadia/issues/178)) ([4fddd00](https://github.com/byte5ai/omadia/commit/4fddd003aa2bc2eab340d444cf9140130ac396c5))
* **web-ui:** rename middleware.ts to proxy.ts for Next 16 ([#111](https://github.com/byte5ai/omadia/issues/111)) ([e5221b5](https://github.com/byte5ai/omadia/commit/e5221b5e7710936d50ad34c4fd70a2fbcb2ffc55))
* **web-ui:** replace awkward German heading on builder page ([#97](https://github.com/byte5ai/omadia/issues/97)) ([7618874](https://github.com/byte5ai/omadia/commit/76188746c9c8451ad0cbb77ef620b9eb8ef5a602))

## [Unreleased]

_Nothing yet — changes land here before the next tagged release._

---

## [0.2.0] — 2026-06-05

Second public release of omadia — *An Agentic OS*. 155 commits since v0.1.0.
Headline work: a multi-orchestrator runtime, the omadia UI canvas channel with a
WebSocket transport, a plugin store with remote registries, a major builder
upgrade (persona / quality / audit), the answer verifier, operator-owned Privacy
Mode, and headless Office generation. Pre-1.0: schemas and internal surfaces may
still change between minor versions.

### Added

- **Multi-orchestrator runtime** (US1–US9): run multiple orchestrators with
  strict per-orchestrator memory + Knowledge-Graph isolation, per-channel
  `dispatch_service` routing, and per-binding agent routing with `channelType`
  autodiscovery.
- **omadia UI canvas channel**: an additive canvas interface surface on the
  channel SDK, a WebSocket transport for channel plugins (handshake + turn +
  surface fan-out), canvas sentinel parsers with a canvas-output gate, and
  skeleton `ui-channel` / `ui-orchestrator` plugins.
- **Plugin store (MVP)**: admin-managed remote registries, remote install with
  `depends_on` chaining, and update detection with store-card update prompts.
- **Builder upgrades**: service-type auto-discovery for integration-backed
  agents, preview that reads through to the live `ServiceRegistry`, persona
  templates + gallery (6 archetypes), a quality-score engine + panel, a
  live compiled system-prompt preview, culture presets (6 industry overlays),
  an audit-log backend + timeline UI, a `read_slot` tool, and plan-as-data
  foundations.
- **Answer verifier**: tool-output postcondition validation with retry,
  citation enforcement for Knowledge-Graph-grounded answers, and
  confidence-gated re-sampling on borderline verdicts.
- **Privacy**: operator-owned per-plugin Privacy Mode and stable-id
  tokenization for the privacy-guard proxy.
- **Headless Office**: deterministic `.xlsx` / `.docx` generation with
  multi-channel delivery.
- **Cross-session memory**: a Knowledge-Graph recall probe for plans, processes
  and team insights, with relevance-filtered cross-session plan recall.
- **Knowledge-Graph ACL + curated-memory** system.
- **Setup wizard collects the LLM key** (OB-61): the Anthropic API key is now
  gathered through the first-user setup wizard and stored encrypted in the
  per-plugin vault — `ANTHROPIC_API_KEY` in the environment is no longer
  required.
- **plugin-api**: structured-output + `writeCapabilities` contract, and
  `EntityRef.op` widened to `'read' | 'write'`.
- Localized third-party setup guides (`setup.guide`).
- Architecture Decision Records under `docs/adr`.
- Native issue-reporting + workaround-tracking for the agent builder.
  When the builder hits a platform-side failure (forbidden-import
  gate on valid code, codegen-internal error, core-stack-frame
  crash, admin-route schema violation), it now offers the operator
  a smart card with three options: report + workaround, report +
  pause, or skip. Reports go through a browser-submit flow against
  `byte5ai/omadia` so the operator owns the GitHub attribution; the
  middleware never sees a PAT in v1. A 64 KB sanitizer strips
  AWS keys / GitHub PATs / Slack tokens / IBANs / emails / internal
  URLs before the operator confirms. Per-operator rate limit of 3
  platform reports per 24 h, deduplication via a stable
  fingerprint hash + GitHub search, ETag-aware status cache with
  rate-limit backoff, pause-on-issue with operator-triggered
  resume. Workaround lifecycle state survives re-installs in the
  new `agent_workaround_state` table; identity (issue ref +
  fingerprint + summary) lives on the spec so the manifest carries
  it through to installed agents.
- RFC `docs/cross-channel-memory.md` proposing two new core capabilities,
  `platformIdentity@1` and `crossChannelConversationMemory@1`, plus four
  provider plugins (Neon + in-memory siblings per capability). Driven by
  the omadia-ui Tier-2 orchestrator's hard dependency on
  `crossChannelConversationMemory@1` and the "Telegram → desktop"
  continuity scenario. Additive against `harness-channel-sdk`: the
  existing `ConversationHistoryStore` contract stays unchanged; a new
  `DurableConversationHistoryStore` adapter bridges to the capability
  and falls back to in-memory behavior when the capability is not
  installed. The RFC also specifies a small additive extension to
  `TurnContextValue` in `harness-orchestrator` (`tenantId?`,
  `originatorUserRef?`, `originatorUserId?`, `canvasSessionId?`),
  which lands with PR 4 and absorbs the Phase-12 `tenantId` work from
  `docs/middleware-agent-handoff.md`. The RFC went through three
  Codex-style review rounds before landing: service-registry-key form,
  `TurnContextValue` field availability, the dual `ConversationTurn`
  shape in the SDK, misuse of `ctx.notifications` as an ops/audit
  surface, identity-merge race-safety, outbox idempotency via
  `client_message_id`, structured `CcmAppendError` failure taxonomy,
  audit-event PII minimization plus retention, and the absence of a
  `permissions.routes` manifest key were all fixed against the real
  code in `middleware/packages/` before merge. PR sequence and
  consumer mechanics are spelled out in §15 of the RFC;
  `docs/middleware-agent-handoff.md` §13 gains a Phase 13 roadmap
  entry pointing at the RFC.
- byte5ai engineering-standards applied to the repo
  (`status: applied` in `.github/engineering-standards.yml`):
  - `.hooks/pre-push` blocks direct pushes to `main`/`master` locally.
  - `script/setup` activates the hook and runs the npm bootstrap in one step.
  - AGENTS.md gained a "Git Workflow & Engineering Standards" section.
  - CONTRIBUTING.md documents the pre-push guard and forbids
    `Co-Authored-By:` trailers for AI agents.
  - Server-side branch protection on `main`: pull request required,
    force-push and deletion blocked, all five CI workflow contexts wired
    up as required status checks.
- GitHub Actions re-enabled after the 2026-05-11 outage; first
  post-reactivation runs landed green on the same day.

### Changed

- Public-facing text now brands the product as **omadia** (formerly "Harness").
- Default orchestrator model set to `claude-opus-4-7` (a stale id previously
  caused 404s).
- web-ui: `middleware.ts` renamed to `proxy.ts` for Next.js 16 compatibility.
- `docs/CHANGELOG.md` reformatted to follow the Keep-a-Changelog convention.
  Detailed operational history prior to v0.1.0 is preserved in the git log.
- Replaced the internal `docs/security-migration-plan.md` post-mortem with
  `docs/security-architecture.md`, which describes the generic patterns
  (proxy-over-direct calls, secrets in a vault, scope-locked sub-agent tools)
  without incident-specific identifiers.
- Sanitised `middleware/packages/harness-diagrams` package metadata to remove
  internal hostnames and branding.

### Fixed

- Orchestrator resilience: retry on mid-stream Anthropic `overloaded_error`,
  explicit `maxRetries=5` with turn-failure logging, quarantine of uninstalled
  plugins instead of aborting registry boot, and per-Agent domain tools scoped
  to enabled plugins only.
- Privacy: hardened outbound payloads against lone UTF-16 surrogates; the
  privacy-guard now renders real names instead of apologising, and expands
  "summary + detail" tool results into per-record rows.
- Builder: AST-writes `network.outbound` so integration-backed agents build,
  unblocked non-search plugin specs, scoped plugin ids work end-to-end, and
  new agents emit the `@omadia/agent-*` namespace.
- web-ui: visible session-expiry handling (warning + auto-logout), the plugin
  install drawer is scrollable for long config forms, and the React-Compiler
  warnings were cleared.
- CI pipeline brought back to green after the Actions outage:
  - `actions/setup-node` bumped from `20` to `22` to match
    `middleware/package.json` `engines.node ">=22 <23"`.
  - `schema (migrations on pgvector)` job moved from a stale hardcoded
    list to a glob over five migration domains; coverage went from 9 to
    20 migrations and is now self-updating.
  - `sharp` linux-x64 native binary installed explicitly so the diagram
    test suite can load on CI runners.
  - `middleware/src/index.ts` `prefer-const` false-positive on an
    intentional forward reference suppressed with a documented disable.
- Middleware test suite cleared of stale workshop-vs-public drift: back
  to 2168 passing / 0 failing (7 tests carry `it.skip()` with TODO
  comments documenting root cause — tracked separately for follow-up
  if/when operationally relevant).

---

## [0.1.0] — 2026-05-11

Initial public release of Omadia — *An Agentic OS*.

### Added

- Middleware kernel with plugin runtime, capability registry, and
  scope-locked sub-agent tools.
- Web UI (`web-ui/`) for operator onboarding, plugin install via ZIP upload,
  and chat sessions.
- Reference plugins: `harness-diagrams`, `harness-memory`, and the
  `agent-reference-maximum` / `agent-seo-analyst` boilerplates.
- Docker Compose deployment recipe.
- AGENTS.md + four-file documentation set
  (`docs/README.md`, `docs/middleware-agent-handoff.md`,
  `docs/CHANGELOG.md`, `docs/security-architecture.md`).

### Notes

- Licence: MIT.
- The full pre-release development history is preserved in the maintainer's
  internal repository and is not part of the public git history.

[Unreleased]: https://github.com/byte5ai/omadia/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/byte5ai/omadia/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/byte5ai/omadia/releases/tag/v0.1.0
