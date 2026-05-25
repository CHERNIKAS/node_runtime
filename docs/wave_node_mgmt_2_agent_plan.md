# Wave NODE-MGMT-2-AGENT — node-agent /health emits a `dns` block

Звено 2/3 цепочки DNS-status (orchestrator passthrough уже сделан в
Wave NODE-MGMT-2; рендер бота — третий, отдельный промпт). Цель:
node-agent должен сам сообщать, что нода резолвит локально (unbound +
`resolv.conf` → 127.0.0.1) и реально получает ответы, а не утекает в
Cloudflare.

## Branch / baseline

* Репо: `node_runtime` (source-of-truth `new` remote).
* Ветка: `wave/node-mgmt-2-agent` от `new/main` (= `f193dcb`).
* Файл: `node_runtime/node_agent/server.js` (Node.js, без сборки).
* Тест-харнес отсутствует (`package.json` нет, тестовых файлов нет) —
  Stage C сводится к `node --check` + ручному смок-плану.

## Stage A — `checkDns(timeoutMs)`

Хелпер мирорит форму `checkIpv6Egress` (~:1055): возвращает плоский
объект, никогда не бросает, таймаут 5000ms по умолчанию.

Контракт (потребляется оркестратором как opaque-passthrough; бот рендерит):

```js
{
  ok: boolean,             // unbound && resolver_local && resolves
  unbound: boolean,        // systemctl is-active unbound == "active"
  resolver_local: boolean, // /etc/resolv.conf первый nameserver == 127.0.0.1
  resolves: boolean,       // dns.Resolver([127.0.0.1]).resolve4("google.com") OK
  error: string | null     // первая словесная причина, либо null
}
```

Под-проверки:

* `unbound` — `runCommand("systemctl", ["is-active", "unbound"], {timeoutSec})`;
  `trim(stdout) === "active"` ⇒ true, любая иная исход (rc≠0, нет
  systemd, exception) ⇒ false, не бросаем.
* `resolver_local` — `fs.readFile /etc/resolv.conf`, первый
  не-комментарийный `nameserver` равен ровно `127.0.0.1`. Нет файла /
  нет nameserver-строки ⇒ false.
* `resolves` — `new dns.Resolver()` + `setServers(["127.0.0.1"])` +
  `resolve4("google.com")` с локальной фейк-`setTimeout`-обвязкой для
  принудительного дедлайна `timeoutMs` (Node-`dns` не имеет нативного
  таймаута на резолвере, поэтому гонка `Promise.race`). Выбран
  Node-`dns` вместо `dig`, чтобы не зависеть от `dnsutils` пакета
  (mature node default).
* `error` — первая словесная причина (например `"unbound_not_active"`
  / `"resolver_not_local"` / `"resolve_failed:<msg>"`).

## Stage B — `dns` в `/health` и `/describe`

* `handleHealth` (~:2571) — рядом с `ipv6Check`, параллельный вызов
  `checkDns(5000)` (через `Promise.all` — экономия 5 секунд на
  worst-case). В JSON-ответ добавлен ключ `dns` (additive, остальные
  поля не трогаются).
* `handleDescribe` (~:2614) — внутрь `healthSnapshot` добавлен ключ
  `dns`; `describe.js::buildDescribe` пробрасывает его в финальный
  объект как `dns` (рядом с `ipv6` / `ipv6_egress`).

## Stage C — `node --check` + смок-план

Тест-харнеса нет → unit-тестов добавить некуда. План валидации:

1. **Синтаксис**: `node --check node_runtime/node_agent/server.js` →
   должен пройти без stdout.
2. **Live-smoke на ноде после deploy** (отдельным шагом, не в этой
   ветке):
   * `systemctl restart node-agent`
   * `curl -s http://127.0.0.1:8085/health | jq .dns`
     → ожидаем `{"ok": true, "unbound": true, "resolver_local": true,
        "resolves": true, "error": null}` на правильно настроенной ноде.
   * Намеренно положить unbound (`systemctl stop unbound`) →
     `dns.ok === false`, `dns.unbound === false`, `dns.resolves` тоже
     уйдёт в false, `error` непустой.
   * Поправить `/etc/resolv.conf` (например `nameserver 1.1.1.1`) →
     `dns.resolver_local === false`, `dns.ok === false`.
3. `curl -s http://127.0.0.1:8085/describe | jq .dns` — то же поле в
   describe-снимке.

## Journal

* (заполняется по ходу)
