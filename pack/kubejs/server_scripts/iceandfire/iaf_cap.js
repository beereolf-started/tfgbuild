// Предел тварей Ice and Fire в одном месте - откуда бы они ни взялись: собственный спавн мода (черви в
// пустыне с «весом» 1 шли десятками), волны, danger_spawns. В 48 блоках - не больше 3 существ одного вида
// и 10 всего. Новые сверх предела не появляются, лишние вокруг игроков убираются (сначала самые свежие).
// Не трогаем: боссов (драконы, гидра, морской змей), приручённых и названных.

const IC_R = 48
const IC_PER_TYPE = 3
const IC_TOTAL = 10
const IC_BOSS = /dragon|hydra|sea_serpent/

function icManaged(e) {
    try {
        var t = String(e.getType())
        if (t.indexOf("iceandfire:") !== 0 || IC_BOSS.test(t)) return false
        if (e.isTame && e.isTame()) return false
        if (e.hasCustomName && e.hasCustomName()) return false
        return e.isAlive()
    } catch (err) { return false }
}

function icAround(level, x, y, z) {
    var out = []
    try {
        var AABB = Java.loadClass("net.minecraft.world.phys.AABB")
        var list = level.getEntitiesWithin(new AABB(x - IC_R, y - IC_R, z - IC_R, x + IC_R, y + IC_R, z + IC_R))
        for (var i = 0; i < list.size(); i++) if (icManaged(list.get(i))) out.push(list.get(i))
    } catch (err) {
        try {
            var all = level.getEntities()
            for (var j = 0; j < all.size(); j++) {
                var e = all.get(j)
                if (!icManaged(e)) continue
                if (Math.pow(e.getX() - x, 2) + Math.pow(e.getZ() - z, 2) < IC_R * IC_R) out.push(e)
            }
        } catch (err2) { }
    }
    return out
}

EntityEvents.spawned(event => {
    var e = event.entity
    if (!icManaged(e)) return
    try {
        var near = icAround(e.level, e.getX(), e.getY(), e.getZ())
        var t = String(e.getType())
        var same = near.filter(o => String(o.getType()) === t && String(o.uuid) !== String(e.uuid)).length
        if (same >= IC_PER_TYPE || near.length > IC_TOTAL) event.cancel()
    } catch (err) { }
})

ServerEvents.tick(event => {
    if (event.server.tickCount % 100 !== 30) return
    event.server.players.forEach(p => {
        try {
            var near = icAround(p.level, p.getX(), p.getY(), p.getZ())
            if (near.length <= IC_PER_TYPE) return
            near.sort((a, b) => Number(a.tickCount) - Number(b.tickCount))      // свежие - первыми под нож
            var byType = {}, kept = 0, removed = 0
            near.slice().reverse().forEach(e => {                               // старых оставляем
                var t = String(e.getType())
                byType[t] = (byType[t] || 0) + 1
                if (byType[t] > IC_PER_TYPE || kept >= IC_TOTAL) { e.discard(); removed++ }
                else kept++
            })
            if (removed) console.info("[tfg-iaf-cap] у " + p.username + ": лишних тварей убрано " + removed)
        } catch (err) { }
    })
})
