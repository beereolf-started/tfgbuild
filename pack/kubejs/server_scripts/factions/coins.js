// priority: 5
"use strict";

/**
 * МОНЕТЫ ФРАКЦИЙ.
 *
 * Деньги - монеты Create Deco. Их чеканят на формовочном прессе GregTech из самородка
 * (kubejs/server_scripts/createdeco/recipes.js), то есть подделать их легко. Поэтому:
 *  - верифицированная монета (NBT tfg_verified) идёт по номиналу у торговцев всех фракций;
 *  - неверифицированная - безделушка: торговцы её не берут, скупщик берёт как лом (COIN_TRINKET).
 * Верифицированные монеты игрок получает только от NPC: сдача, выплаты скупщика, оценщик.
 *
 * Номиналы - в медяках (стоимость медной монеты), ряд 1-5-10 по ценности металла.
 * Стопка монет Create Deco (coinstack) = 4 монеты, но верифицированной не бывает:
 * при крафте NBT теряется.
 *
 * Отдаёт global.TFG_COINS: faceValue, isVerified, verifiedTotal, pay (со сдачей), give, giveRandom, verifyAll.
 */

const COIN_DENOMS = [
    { id: "createdeco:netherite_coin", value: 1000, name: "из синей стали" },
    { id: "createdeco:gold_coin", value: 500, name: "золотая" },
    { id: "createdeco:industrial_iron_coin", value: 100, name: "стальная" },
    { id: "createdeco:iron_coin", value: 50, name: "из кованого железа" },
    { id: "createdeco:brass_coin", value: 10, name: "латунная" },
    { id: "createdeco:zinc_coin", value: 5, name: "цинковая" },
    { id: "createdeco:copper_coin", value: 1, name: "медная" },
]
const COIN_STACK_SIZE = 4
const COIN_TRINKET = 1                  // цена неверифицированной монеты у скупщика
const COIN_UNIT = "медяков"
const COIN_ItemStack = Java.loadClass("net.minecraft.world.item.ItemStack")

var COIN_BY_ID = {}
COIN_DENOMS.forEach(d => {
    COIN_BY_ID[d.id] = { value: d.value, stack: 1, name: d.name }
    COIN_BY_ID[d.id.replace("_coin", "_coinstack")] = { value: d.value * COIN_STACK_SIZE, stack: COIN_STACK_SIZE, name: d.name }
})

/** Номинал одного предмета (монеты или стопки), 0 - не монета. */
function coinFace(stack) {
    if (!stack || stack.isEmpty()) return 0
    var c = COIN_BY_ID[String(stack.id)]
    return c ? c.value : 0
}

function coinIsVerified(stack) {
    if (coinFace(stack) === 0) return false
    var nbt = stack.getNbt()
    return !!nbt && nbt.getBoolean("tfg_verified")
}

function coinVerifiedStack(id, count) {
    return Item.of(id, count, {
        tfg_verified: true,
        display: { Lore: [JSON.stringify({ text: "Верифицировано", color: "green", italic: false })] },
    })
}

/** Разложить сумму на монеты: жадно, от крупных к мелким. */
function coinSplit(amount) {
    var out = []
    COIN_DENOMS.forEach(d => {
        var n = Math.floor(amount / d.value)
        if (n > 0) {
            out.push({ id: d.id, count: n })
            amount -= n * d.value
        }
    })
    return out
}

/** Разложить сумму случайными номиналами (выплаты скупщика). */
function coinSplitRandom(amount) {
    var counts = {}
    while (amount > 0) {
        var allowed = COIN_DENOMS.filter(d => d.value <= amount)
        var d = allowed[Math.floor(Math.random() * allowed.length)]
        var n = 1 + Math.floor(Math.random() * Math.min(5, Math.floor(amount / d.value)))
        counts[d.id] = (counts[d.id] || 0) + n
        amount -= n * d.value
    }
    return COIN_DENOMS.filter(d => counts[d.id]).map(d => ({ id: d.id, count: counts[d.id] }))
}

/**
 * Инвентарь, с которым работаем. Пока открыто меню-сундук KubeJS, предметы основного инвентаря игрока лежат
 * во временном контейнере меню (ServerPlayerKJS.captureInventory: вынимает их и вернёт при закрытии), а сам
 * инвентарь пуст. Поэтому торговец в момент клика видел "у вас 0" при 2000 монетах. Берём контейнер меню,
 * если оно открыто, иначе обычный инвентарь.
 */
function coinInv(player) {
    try {
        var menu = player.containerMenu
        if (menu && menu.data && menu.data.capturedInventory) return menu.data.capturedInventory
    } catch (e) { }
    return player.getInventory()
}

/** Положить предмет в этот инвентарь: сначала в такие же стопки, потом в пустые слоты, остаток - под ноги. */
function coinInsert(player, stack) {
    var inv = coinInv(player)
    var size = inv.getContainerSize()
    for (var i = 0; i < size && !stack.isEmpty(); i++) {
        var s = inv.getItem(i)
        if (s.isEmpty() || !COIN_ItemStack.isSameItemSameTags(s, stack)) continue
        var room = s.getMaxStackSize() - s.getCount()
        if (room <= 0) continue
        var n = Math.min(room, stack.getCount())
        s.grow(n)
        stack.shrink(n)
    }
    for (var j = 0; j < size && !stack.isEmpty(); j++) {
        if (!inv.getItem(j).isEmpty()) continue
        var m = Math.min(stack.getMaxStackSize(), stack.getCount())
        inv.setItem(j, stack.copyWithCount(m))
        stack.shrink(m)
    }
    if (!stack.isEmpty()) player.drop(stack, false)
}

function coinGiveParts(player, parts) {
    parts.forEach(p => coinInsert(player, coinVerifiedStack(p.id, p.count)))
}

function coinInventory(player) {
    var inv = coinInv(player)
    var out = []
    for (var i = 0; i < inv.getContainerSize(); i++) out.push({ slot: i, stack: inv.getItem(i) })
    return out
}

function coinVerifiedTotal(player) {
    var total = 0
    coinInventory(player).forEach(s => {
        if (coinIsVerified(s.stack)) total += coinFace(s.stack) * s.stack.getCount()
    })
    return total
}

/**
 * Заплатить price верифицированными монетами. Если ровно без сдачи не выходит, все верифицированные
 * монеты забираются и сдача выдаётся заново крупными номиналами. false - не хватает денег.
 */
function coinPay(player, price) {
    price = Math.round(Number(price))
    var total = coinVerifiedTotal(player)
    if (total < price) return false
    coinInventory(player).forEach(s => {
        if (coinIsVerified(s.stack)) s.stack.setCount(0)
    })
    coinGiveParts(player, coinSplit(total - price))
    return true
}

/**
 * Верифицировать неверифицированные монеты игрока на сумму до limit (целыми монетами) с комиссией.
 * Возвращает { taken, commission, paid } в медяках.
 */
function coinVerifyAll(player, limit, commissionRate) {
    var taken = 0
    coinInventory(player).forEach(s => {
        var face = coinFace(s.stack)
        if (face === 0 || coinIsVerified(s.stack)) return
        var n = Math.min(s.stack.getCount(), Math.floor((limit - taken) / face))
        if (n <= 0) return
        s.stack.shrink(n)
        taken += n * face
    })
    var commission = Math.ceil(taken * commissionRate)
    coinGiveParts(player, coinSplit(taken - commission))
    return { taken: taken, commission: commission, paid: taken - commission }
}

global.TFG_COINS = {
    inv: player => coinInv(player),
    insert: (player, stack) => coinInsert(player, stack),
    denoms: COIN_DENOMS,
    unit: COIN_UNIT,
    trinket: COIN_TRINKET,
    faceValue: stack => coinFace(stack),
    isCoin: stack => coinFace(stack) > 0,
    isVerified: stack => coinIsVerified(stack),
    verifiedTotal: player => coinVerifiedTotal(player),
    pay: (player, price) => coinPay(player, price),
    give: (player, amount) => coinGiveParts(player, coinSplit(Math.round(amount))),
    giveRandom: (player, amount) => coinGiveParts(player, coinSplitRandom(Math.round(amount))),
    verifyAll: (player, limit, rate) => coinVerifyAll(player, limit, rate),
    split: amount => coinSplit(amount),
    splitRandom: amount => coinSplitRandom(amount),
}

// ─── /tfgcoins give <сумма> - выдать себе верифицированные монеты (оператор, для проверки) ───────

ServerEvents.commandRegistry(event => {
  try {
      var Commands = event.commands
      var Arguments = event.arguments
      event.register(Commands.literal("tfgcoins").requires(src => src.hasPermission(2))
          .then(Commands.literal("give").then(Commands.argument("amount", Arguments.INTEGER.create(event))
              .executes(ctx => {
                  try {
                      var player = ctx.source.getPlayerOrException()
                      var amount = Math.max(1, Number(Arguments.INTEGER.getResult(ctx, "amount")))
                      coinGiveParts(player, coinSplit(amount))
                      ctx.source.sendSuccess(Text.of("Выдано верифицированных монет на " + amount + " " + COIN_UNIT +
                          ". Всего у вас: " + coinVerifiedTotal(player)), false)
                  } catch (e) {
                      ctx.source.sendFailure(Text.of("Ошибка /tfgcoins: " + String(e).substring(0, 300)))
                  }
                  return 1
              }))))
  } catch (err) {
    console.error("[coins] ошибка регистрации команд: " + err)
  }
})
