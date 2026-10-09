# Biblio MCP review archive

Все материалы `biblio-mcp-review` перенесены сюда: план, результаты этапов, red/green логи,
CI receipts, dependency audits, snapshots, patches, release artifacts и reproductions.

**Начинайте с [HANDOFF.md](HANDOFF.md)** — там текущий статус и следующий шаг. Старые отчёты
фиксируют состояние на дату своего этапа, а не сегодняшнее состояние registry/release.

Рабочий checkout не вложен внутрь собственного архива: это корень репозитория. В sandbox он
перенесён из `/home/user/biblio-mcp-review/repo` в `/home/user/biblio-mcp`. Старый внешний путь
`/home/user/biblio-mcp-review` оставлен как локальный alias к этому архиву, не как второй checkout.

Исторические логи намеренно сохраняют старые абсолютные пути. Reproductions и `tooling/`
помечены как исторические материалы: не запускайте их автоматически. Для повторной проверки
используйте актуальные команды из корня проекта и `scripts/check-artifacts.mjs`.

Все обычные материалы сохранены. `.git`, установленные `node_modules`, generated `dist`, caches
и credential files не публикуются; они не являются частью доказательств или переносимого исходника.
`archive-manifest.json` фиксирует содержимое и SHA-256 материалов перед финализацией.
