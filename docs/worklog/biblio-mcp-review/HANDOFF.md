# HANDOFF — Biblio MCP 2.0.0

**Дата: 9 октября 2026. Это активная точка входа для следующего агента.** Старые отчёты и
снимки рядом — доказательства состояния на дату этапа, не текущие инструкции.

## Текущий статус

- Репозиторий: [`vernikr/biblio-mcp`](https://github.com/vernikr/biblio-mcp), рабочая ветка **main**.
- npm **опубликован**: [`@vernikr/biblio-mcp@2.0.0`](https://www.npmjs.com/package/@vernikr/biblio-mcp), public/latest.
  Registry tarball скачан и совпадает с проверенным файлом; см. [`npm-publication.json`](npm-publication.json).
- GitHub release `v2.0.0`: draft с тремя загруженными файлами; финальная публикация после проверки этого checkpoint.
  Статус будет обновлён в этом файле; draft receipt — [`github-release-draft.json`](github-release-draft.json).
- Runtime: **Node 22+**, CI проверяет LTS 22/24 и точный минимум 22.0.0.
- Артефакты, совпадающие с npm: [`published-artifacts/`](published-artifacts/). `release-artifacts/` —
  более ранний, подготовленный вариант до публикации; не публикуйте его повторно под 2.0.0.
- Материалы ревью полностью перенесены в `docs/worklog/biblio-mcp-review/`. В sandbox checkout —
  `/home/user/biblio-mcp`; переносимый ориентир для другого агента — **корень Git checkout**.

## Что завершено

1. **PR1 (F1/F2/F3)** — locked install до dependency preflight, config validation до backup,
   атомарный no-clobber для явных filenames. Default MD5 filenames сохраняют replacement contract.
2. **PR2 (F7/F8/F9, X1/X2)** — stagger=0, правильное имя Z-Library override, пустой ввод до сети,
   SDK stdio result вместо CI grep, single-build offline `verify`, свежий `docs:env`.
3. **PR2b + deps** — собственный npm scope, один compiled runtime для npm/MCPB, hoisted locked
   production deployment, consumer Quick start отдельно от development. SDK 1.32.1, Zod 4.6.5,
   Cheerio 1.2.0, TS 7.0.2, tsx 4.23.15, Node types 22.20.5; pnpm 12.10.1.
4. Истинные npm registry launches: **cold npx** (отдельный cache/prefix) и **pnpm dlx** без локального
   tarball substitute проверены после публикации — initialize/list/invalid-call/полное скачивание.
   См. [`published-registry-launchers.log`](published-registry-launchers.log).

## Быстрый старт агента

Из корня checkout, Node 22 или 24 LTS и pnpm 12.10.1:

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run package:verify
# Только для УЖЕ опубликованной текущей версии:
node scripts/check-artifacts.mjs --registry
```

`verify` — offline, **одна top-level сборка**, локальные HTTP fixtures; dependency-install fixtures
работают offline из прогретого pnpm store. Нужен pnpm на PATH, иначе некоторые installer tests
будут skipped: для приёмки нужен полный прогон без skips. `package:verify` и cold launchers могут
использовать **npm registry**, но не живые shadow-library mirrors. Live: `pnpm run verify:live`
отдельно. Generated `artifacts/`, `dist/`, `node_modules` не коммитить.

Проверки до передачи: **203/203** offline tests на Node 22/24, **28/28** на 22.0.0; acceptance
npm/npx/pnpm/MCPB с настоящими сохранёнными байтами. Последний зелёный distribution CI:
[7/7 jobs](https://github.com/vernikr/biblio-mcp/actions/runs/37856503504), включая Linux/macOS/Windows.
Финальный checkpoint CI сохраняется отдельным receipt рядом с этим файлом.

## Следующая работа — PR3, не release/bootstrap заново

См. [план исполнения](plan.md#5-план-исполнения) и исторический baseline в `snapshot.json`.

- **F4:** определить контракт download timeout — текущий timer покрывает headers, body имеет
  idle watchdog. Не считать это полным deadline; выбор полного deadline/переименования ещё не сделан.
- **F5:** отличать outage (all 503/network) от healthy not-found (all 404/semantic miss).
- **F6:** mixed Sci-Hub no-PDF/PDF должен дождаться PDF; semantic miss не должен отменять победителя.
- **R3:** переиспользовать уже созданный DOM Libgen для download links вместо второго parse.
- **R4:** не читать HTML body ради неиспользуемых error payload fields; сохранять typed HTML rejection.
- Затем PR4: test lifecycle/metadata/HTTP boilerplate, активные docs. Не удалять уникальные сценарии
  или genuine provider captures ради количества строк/тестов.

## Инварианты и ограничения

- Прямое указание пользователя: завершённые изменения **пушить в main**, не отдельный PR.
  Fetch → сохранять чужие commits → проверить итоговый код → normal push. **Никакого force-push.**
- **2.0.0 уже immutable в npm.** При новых runtime changes нужна новая версия и новая проверенная
  публикация; не пытаться перепубликовать другой tarball под 2.0.0.
- SDK pinned. Readable argument errors переводят SDK diagnostic **без второго schema parse**;
  приватный validation hook не переписывать без negative tests. `_parse` compatibility regression в CI сохранён.
- Сохранить atomic filename protection, config/backup safety, bounded caches, circuits, loser cancellation,
  MD5/HTML checks и member-key restriction на verified hosts.
- Не решать human-verification/ALTCHA; не обещать доступность зеркал, marketplace/автообновления MCPB.
- Desktop GUI installation не проверялась: проверены manifest и actual runtime на трёх OS.
- Production audit: **0**. В MCPB build CLI остаётся dev-only unpatched node-forge RSA-verification
  advisory GHSA-86w9-cpqp-85rv. CLI signing/verification не используется, MCPB unsigned; библиотека
  отсутствует в runtime. Patched `tmp` pinned. Не подавлять warning и не делать вид, что full audit чистый.
- Credentials **не лежат в репозитории**. Не добавлять PAT/npm/member keys в документы или commit.
  Запрашивать доступ через безопасный environment/temporary auth при необходимости, не вставлять
  секреты в URL или постоянный `.npmrc`. npm authentication и GitHub PAT — разные права.

## Навигация по доказательствам

- [README архива](README.md), [`archive-manifest.json`](archive-manifest.json) — сохранённые материалы и hashes.
- [`pr1-result.md`](pr1-result.md), [`pr2-result.md`](pr2-result.md), [`pr2b-result.md`](pr2b-result.md) —
  исторические checkpoints с scope/проверками; pending publication в старом PR2b отчёте уже закрыта.
- [`npm-publish-eotp.log`](npm-publish-eotp.log) — первая попытка была заблокирована 2FA; новый token
  разрешил публикацию. [`npm-publish.log`](npm-publish.log) — успешная операция, без credential values.
- `published-artifacts/SHA256SUMS` — единственные hashes текущих published tarball/MCPB.
- Исторические reproductions сохраняют старые абсолютные пути/Node versions. Не запускать их
  автоматически; текущие gate/consumer scripts находятся в корневом `scripts/`.
