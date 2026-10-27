// priority: 5
"use strict";

/**
 * ФРАКЦИИ ИГРОКОВ И ИХ ПОСЕЛЕНИЯ.
 *
 * Игрок создаёт фракцию (/faction create <название>), выбирает цвет, приглашает других игроков и
 * отмечает центр базы. Всё остальное меню - /faction (меню-сундук KubeJS, клиентских модов не нужно).
 * Центр базы с радиусом SET_BASE_RADIUS - поселение: сюда приходят торговцы, рейды и караваны.
 * Репутация у фракций-NPC (factions/core.js) считается на фракцию игрока.
 *
 * Хранение: одна строка JSON в данных сервера (tfg_pfac). Отдаёт наружу global.TFG_SETTLEMENTS.
 */

const SET_BASE_RADIUS = 300
const SET_NAME_MAX = 32

var SET_SERVER = null
var SET_DATA = null

function setLog(msg) { global.tfgLog("tfg settlements", msg) }

function setLoad() {
    if (SET_DATA) return SET_DATA
    var pd = SET_SERVER.persistentData
    try {
        SET_DATA = pd.contains("tfg_pfac") ? JSON.parse(String(pd.getString("tfg_pfac"))) : null
    } catch (e) {
        global.tfgLogError("tfg settlements", "данные фракций игроков не читаются - начинаю с пустых", e)
    }
    if (!SET_DATA) SET_DATA = { nextId: 1, factions: {} }
    return SET_DATA
}

function setSave() {
    SET_SERVER.persistentData.putString("tfg_pfac", JSON.stringify(SET_DATA))
}

function setUuid(player) { return String(player.uuid) }

function setFactionOf(player) {
    var data = setLoad()
    var id = setUuid(player)
    for (var k in data.factions) {
        if (data.factions[k].members.indexOf(id) >= 0) return data.factions[k]
    }
    return null
}

function setColor(name) {
    var colors = global.TFG_FACTION_COLORS
    for (var i = 0; i < colors.length; i++) if (colors[i].id === name) return colors[i]
    return colors[0]
}

/** База фракции игрока, если он в том же измерении и в радиусе поселения; иначе null. */
function setBaseFor(player) {
    var f = setFactionOf(player)
    if (!f || !f.base) return null
    if (String(player.level.getDimension()) !== f.base.dim) return null
    var dx = player.getX() - f.base.x
    var dz = player.getZ() - f.base.z
    if (dx * dx + dz * dz > SET_BASE_RADIUS * SET_BASE_RADIUS) return null
    return { x: f.base.x, y: f.base.y, z: f.base.z, dim: f.base.dim, radius: SET_BASE_RADIUS, faction: f }
}

global.TFG_SETTLEMENTS = {
    radius: SET_BASE_RADIUS,
    factionOf: player => setFactionOf(player),
    baseFor: player => setBaseFor(player),
    all: () => Object.keys(setLoad().factions).map(k => setLoad().factions[k]),
}

// ─── Действия ────────────────────────────────────────────────────────────────

function setCreate(player, name) {
    var data = setLoad()
    name = String(name).trim()
    if (setFactionOf(player)) return "Вы уже во фракции - сначала покиньте её."
    if (name.length < 2 || name.length > SET_NAME_MAX) return "Название - от 2 до " + SET_NAME_MAX + " символов."
    for (var k in data.factions) {
        if (data.factions[k].name.toLowerCase() === name.toLowerCase()) return "Фракция с таким названием уже есть."
    }
    var id = "pf" + data.nextId++
    var names = {}
    names[setUuid(player)] = String(player.username)
    data.factions[id] = {
        id: id, name: name, color: "blue", owner: setUuid(player),
        members: [setUuid(player)], names: names, invites: [], base: null,
    }
    setSave()
    setLog(player.username + " создал фракцию " + name + " (" + id + ")")
    return null
}

function setInvite(player, target) {
    var f = setFactionOf(player)
    if (!f) return "Вы не во фракции."
    if (setFactionOf(target)) return target.username + " уже во фракции."
    var tid = setUuid(target)
    if (f.invites.indexOf(tid) < 0) f.invites.push(tid)
    setSave()
    var c = setColor(f.color)
    SET_SERVER.runCommandSilent("tellraw " + target.username + " " + JSON.stringify([
        { text: "[Фракция] ", color: "gold", bold: true },
        { text: player.username + " зовёт вас во фракцию ", color: "white" },
        { text: f.name, color: c.text, bold: true },
        { text: " ", color: "white" },
        { text: "[Вступить]", color: "green", bold: true,
          clickEvent: { action: "run_command", value: "/faction accept " + f.id },
          hoverEvent: { action: "show_text", contents: "Вступить во фракцию " + f.name } },
    ]))
    return null
}

function setAccept(player, id) {
    var data = setLoad()
    var f = data.factions[id]
    if (!f) return "Такой фракции больше нет."
    if (setFactionOf(player)) return "Вы уже во фракции - сначала покиньте её."
    var i = f.invites.indexOf(setUuid(player))
    if (i < 0) return "Приглашения в эту фракцию нет."
    f.invites.splice(i, 1)
    f.members.push(setUuid(player))
    f.names[setUuid(player)] = String(player.username)
    setSave()
    setLog(player.username + " вступил во фракцию " + f.name)
    return null
}

function setLeave(player) {
    var data = setLoad()
    var f = setFactionOf(player)
    if (!f) return "Вы не во фракции."
    var id = setUuid(player)
    f.members.splice(f.members.indexOf(id), 1)
    if (f.members.length === 0) {
        delete data.factions[f.id]
        setLog(player.username + " покинул фракцию " + f.name + " - она распущена")
    } else {
        if (f.owner === id) f.owner = f.members[0]
        setLog(player.username + " покинул фракцию " + f.name)
    }
    setSave()
    return null
}

function setMarkBase(player) {
    var data = setLoad()
    var f = setFactionOf(player)
    if (!f) return "Вы не во фракции."
    if (f.owner !== setUuid(player)) return "Центр базы отмечает только глава фракции."
    var dim = String(player.level.getDimension())
    var x = Math.floor(player.getX())
    var z = Math.floor(player.getZ())
    for (var k in data.factions) {
        var o = data.factions[k]
        if (o.id === f.id || !o.base || o.base.dim !== dim) continue
        var dx = o.base.x - x
        var dz = o.base.z - z
        if (dx * dx + dz * dz < SET_BASE_RADIUS * SET_BASE_RADIUS) return "Слишком близко к базе фракции " + o.name + " (ближе " + SET_BASE_RADIUS + " блоков)."
    }
    f.base = { dim: dim, x: x, y: Math.floor(player.getY()), z: z }
    setSave()
    setLog(f.name + ": центр базы " + dim + " " + x + " " + f.base.y + " " + z)
    return null
}

function setCycleColor(player) {
    var f = setFactionOf(player)
    if (!f || f.owner !== setUuid(player)) return "Цвет меняет только глава фракции."
    var colors = global.TFG_FACTION_COLORS
    var i = colors.indexOf(setColor(f.color))
    f.color = colors[(i + 1) % colors.length].id
    setSave()
    return null
}

// ─── Меню ────────────────────────────────────────────────────────────────────

function setIcon(id, lore, nbt) {
    var tag = nbt || {}
    tag.display = { Lore: lore.map(l => JSON.stringify({ text: l, color: "gray", italic: false })) }
    return Item.of(id, 1, tag)
}

function setNotify(player, err, ok) {
    player.tell(Text.of(err ? "§c" + err : "§a" + ok))
}

function setOpenMain(player) {
    var f = setFactionOf(player)
    if (!f) {
        var data = setLoad()
        var invites = Object.keys(data.factions).map(k => data.factions[k]).filter(o => o.invites.indexOf(setUuid(player)) >= 0)
        player.openChestGUI(Text.of("Фракция"), 3, gui => {
            gui.button(4, 0, setIcon("minecraft:writable_book", [
                "Вы не во фракции.",
                "Создать: /faction create <название>",
            ]), Text.of("Своя фракция"), e => { })
            invites.slice(0, 9).forEach((o, i) => {
                var c = setColor(o.color)
                gui.button(i, 2, setIcon(c.banner, ["Приглашение. Нажмите, чтобы вступить."]), Text.of(o.name), e => {
                    var err = setAccept(player, o.id)
                    setNotify(player, err, "Вы вступили во фракцию " + o.name)
                    if (!err) setOpenMain(player)
                })
            })
        })
        return
    }
    var c = setColor(f.color)
    var isOwner = f.owner === setUuid(player)
    player.openChestGUI(Text.of("Фракция " + f.name), 4, gui => {
        gui.button(0, 0, setIcon(c.banner, ["Глава: " + (f.names[f.owner] || "?"), "Участников: " + f.members.length]),
            Text.of(f.name), e => { })
        gui.button(2, 0, setIcon(c.wool, [isOwner ? "Нажмите, чтобы сменить цвет." : "Цвет меняет глава."]),
            Text.of("Цвет: " + c.name), e => {
                var err = setCycleColor(player)
                if (err) setNotify(player, err)
                else setOpenMain(player)
            })
        var baseLore = f.base
            ? ["Центр: " + f.base.x + " " + f.base.y + " " + f.base.z, "Радиус поселения: " + SET_BASE_RADIUS + " блоков",
               isOwner ? "Нажмите, чтобы перенести центр сюда." : "Центр переносит глава."]
            : ["Центр базы не отмечен.", isOwner ? "Нажмите, чтобы отметить центр здесь." : "Центр отмечает глава."]
        gui.button(4, 0, setIcon("minecraft:compass", baseLore), Text.of("Центр базы"), e => {
            var err = setMarkBase(player)
            setNotify(player, err, "Центр базы отмечен: " + Math.floor(player.getX()) + " " + Math.floor(player.getZ()))
            if (!err) setOpenMain(player)
        })
        gui.button(6, 0, setIcon("minecraft:writable_book", ["Позвать игрока онлайн во фракцию."]), Text.of("Пригласить"),
            e => setOpenInvite(player))
        gui.button(8, 0, setIcon("minecraft:barrier", ["Последний участник распускает фракцию."]), Text.of("Покинуть фракцию"),
            e => {
                var name = f.name
                var err = setLeave(player)
                setNotify(player, err, "Вы покинули фракцию " + name)
                player.closeMenu()
            })
        f.members.slice(0, 18).forEach((m, i) => {
            var name = f.names[m] || "?"
            gui.button(i % 9, 2 + Math.floor(i / 9), setIcon("minecraft:player_head", [m === f.owner ? "Глава" : "Участник"], { SkullOwner: name }),
                Text.of(name), e => { })
        })
    })
}

function setOpenInvite(player) {
    var f = setFactionOf(player)
    if (!f) return setOpenMain(player)
    var candidates = []
    SET_SERVER.players.forEach(p => { if (!setFactionOf(p)) candidates.push(p) })
    player.openChestGUI(Text.of("Пригласить в " + f.name), 3, gui => {
        if (candidates.length === 0) {
            gui.button(4, 1, setIcon("minecraft:paper", ["Все игроки онлайн уже во фракциях."]), Text.of("Некого пригласить"), e => { })
        }
        candidates.slice(0, 18).forEach((p, i) => {
            var name = String(p.username)
            gui.button(i % 9, Math.floor(i / 9), setIcon("minecraft:player_head", ["Нажмите, чтобы пригласить."], { SkullOwner: name }),
                Text.of(name), e => {
                    var target = SET_SERVER.getPlayerList().getPlayerByName(name)
                    var err = target ? setInvite(player, target) : name + " уже вышел из игры."
                    setNotify(player, err, "Приглашение отправлено: " + name)
                })
        })
        gui.button(8, 2, setIcon("minecraft:arrow", ["Назад"]), Text.of("Назад"), e => setOpenMain(player))
    })
}

// ─── Команды: /faction ───────────────────────────────────────────────────────

ServerEvents.tick(event => {
    if (!SET_SERVER) SET_SERVER = event.server
    if (event.server.tickCount % SET_TEAM_EVERY === 0) {
        try { setSyncTeams() } catch (e) { global.tfgLogError("tfg settlements", "команды для общей карты", e) }
    }
})

/**
 * ОБЩАЯ КАРТА ФРАКЦИИ. Мод Xaero's World Map: Synchronized (своя сборка tfg1) делит карту
 * внутри команды таблицы очков с префиксом tfgf_: все её члены видят одну сложенную
 * картинку, чужие - нет. Здесь мы держим эти команды в согласии с фракциями игроков:
 * вступил во фракцию - попал в её команду, вышел - покинул. Раз в пять секунд.
 */
const SET_TEAM_PREFIX = "tfgf_"
const SET_TEAM_EVERY = 100
var SET_TEAMS_MADE = {}

function setSyncTeams() {
    SET_SERVER.players.forEach(p => {
        var f = setFactionOf(p)
        var want = f ? SET_TEAM_PREFIX + f.id : null
        var have = null
        try { var t = p.getTeam(); have = t ? String(t.getName()) : null } catch (e) { }
        if (want && have !== want) {
            if (!SET_TEAMS_MADE[want]) {
                SET_SERVER.runCommandSilent("team add " + want)
                SET_SERVER.runCommandSilent("team modify " + want + " displayName " + JSON.stringify({ text: String(f.name) }))
                SET_TEAMS_MADE[want] = true
            }
            SET_SERVER.runCommandSilent("team join " + want + " " + p.username)
            setLog(p.username + " - в общую карту фракции " + f.name)
        } else if (!want && have && have.indexOf(SET_TEAM_PREFIX) === 0) {
            SET_SERVER.runCommandSilent("team leave " + p.username)
            setLog(p.username + " вышел из фракции - карта снова своя")
        }
    })
}

ServerEvents.commandRegistry(event => {
  try {
      var Commands = event.commands
      var Arguments = event.arguments
      var run = (ctx, fn) => {
          try {
              if (!SET_SERVER) SET_SERVER = ctx.source.getServer()
              fn(ctx.source.getPlayerOrException())
          } catch (e) {
              ctx.source.sendFailure(Text.of("Ошибка /faction: " + String(e).substring(0, 300)))
          }
          return 1
      }
      event.register(Commands.literal("faction")
          .executes(ctx => run(ctx, p => setOpenMain(p)))
          .then(Commands.literal("create").then(Commands.argument("name", Arguments.GREEDY_STRING.create(event))
              .executes(ctx => run(ctx, p => {
                  var err = setCreate(p, Arguments.GREEDY_STRING.getResult(ctx, "name"))
                  setNotify(p, err, "Фракция создана. Отметьте центр базы в меню /faction.")
                  if (!err) setOpenMain(p)
              }))))
          .then(Commands.literal("accept").then(Commands.argument("id", Arguments.WORD.create(event))
              .executes(ctx => run(ctx, p => {
                  var err = setAccept(p, Arguments.WORD.getResult(ctx, "id"))
                  setNotify(p, err, "Вы вступили во фракцию.")
              }))))
          .then(Commands.literal("leave").executes(ctx => run(ctx, p => setNotify(p, setLeave(p), "Вы покинули фракцию."))))
          .then(Commands.literal("list").requires(src => src.hasPermission(2)).executes(ctx => run(ctx, p => {
              var all = global.TFG_SETTLEMENTS.all()
              p.tell(Text.of(all.length ? all.map(f => f.id + " " + f.name + ": " + f.members.length + " чел., база " +
                  (f.base ? f.base.dim + " " + f.base.x + " " + f.base.z : "не отмечена")).join("\n") : "Фракций игроков нет."))
          }))))
  } catch (err) {
    console.error("[settlements] ошибка регистрации команд: " + err)
  }
})
