// priority: 4
"use strict";
/**
 * РЫНОК: кому в этом мире можно продать любую вещь и почём.
 *
 * Правила торговцев в trade_goods.js перечисляют узкие шаблоны id, и мимо них проходило
 * три четверти предметов сборки: вся химия GregTech, мебель Macaw, рельсы, декор,
 * трофеи Ice and Fire. Здесь каждая вещь размечается по признакам, а не по спискам:
 *
 *   1. материал GregTech (порошок, слиток, пластина, самоцвет, руда) - спрашиваем у самого
 *      GregTech, из какого он материала и какой формы (ChemicalHelper.getMaterialEntry);
 *      у материала смотрим свойства: есть слиток - это металл (металлургу), самоцвет -
 *      шахтёру, остальное - химия (химику). Тир - по температуре доменной печи,
 *      радиоактивности и месту элемента в таблице;
 *   2. машины и детали GregTech - механику или электрику по напряжению;
 *   3. прочие моды - по пространству имён и словам в id (мебель плотнику, рельсы механику,
 *      драконьи кости охотнику);
 *   4. если ничего не подошло - по виду самой вещи: еда повару, броня броннику,
 *      оружие оружейнику, блок строителю.
 *
 * Правила складываются, поэтому одну вещь берут сразу несколько торговцев: цинковый
 * слиток - и кузнец, и металлург. А скупщик берёт вообще всё, дёшево: непродаваемых
 * вещей больше нет.
 *
 * Новые торговцы - химик и металлург, у обоих ассортимент растёт с тиром: чистый уран
 * у химика появляется лишь на поздних этапах, сложные сплавы у металлурга - тоже.
 */

const MK_M = 3628800                 // столько «материала» GregTech в одном слитке (GTValues.M)
// цена «слитка» материала по тиру, в единицах меди (медный слиток = 1 = 10 медяков)
const MK_TIER_VALUE = [0, 1.2, 2.2, 4, 8, 14, 24, 32, 45, 65, 90]
const MK_JUNK_SHARE = 0.35           // старьёвщик платит треть: он берёт всё, но задёшево
const MK_JUNK_MIN = 0.25             // и хотя бы четверть медяка за штуку
const MK_PRECIOUS_MARKUP = 1.4       // скупщик за драгоценное платит дороже любого профильного

// драгметаллы: в любой форме - к скупщику
const MK_PRECIOUS_METALS = /^(gold|silver|platinum|palladium|electrum|rose_gold|sterling_silver|osmium|iridium|rhodium|ruthenium|osmiridium|red_alloy)$/
// драгоценное из других модов - по слову в id
const MK_PRECIOUS_WORDS = /(^|[:_\/])(gem|gems|diamond|emerald|amethyst|amythest|ruby|sapphire|topaz|opal|jade|garnet|pearl|jewel|crown|ring_of|necklace|amulet)([_\/]|$)|gold_(ingot|nugget|block|coin)|silver_(ingot|nugget|coin)/

function mkLog(t) { try { console.log("[рынок] " + t) } catch (e) { } }
function mkErr(w, e) { try { console.error("[рынок] " + w + ": " + e) } catch (err) { } }

// ─── Доступ к GregTech ───────────────────────────────────────────────────────

var MK_GT = null
var MK_GT_FAILED = false

/** Классы GregTech: берём один раз; если их нет (стенд), разметка идёт по id. */
function mkGT() {
    if (MK_GT || MK_GT_FAILED) return MK_GT
    try {
        MK_GT = {
            helper: Java.loadClass("com.gregtechceu.gtceu.api.data.chemical.ChemicalHelper"),
            prefix: Java.loadClass("com.gregtechceu.gtceu.api.data.tag.TagPrefix"),
            keys: Java.loadClass("com.gregtechceu.gtceu.api.data.chemical.material.properties.PropertyKey"),
            api: Java.loadClass("com.gregtechceu.gtceu.api.GTCEuAPI"),
        }
    } catch (e) {
        MK_GT_FAILED = true
        mkErr("GregTech недоступен, размечаю по id", e)
    }
    return MK_GT
}

// ─── Материалы: металл, самоцвет или химия, и какого тира ────────────────────

var MK_MAT = {}                      // имя материала -> { name, cls, tier, value, mat }

// Металлы, которые уже оценены вручную в trade_goods.js, берут тир и цену оттуда.
function mkKnownMetal(name) {
    try { return TG_METAL_BY_ID[name] || null } catch (e) { return null }
}

/**
 * Тир по температуре доменной печи - в той же шкале, что и тир игрока (tfg/raid_tiers.js):
 * 4 сталь и LV, 7 алюминий и MV, 8 нержавейка и HV, 9 титан и EV, 10 IV и выше.
 * Пороги - по катушкам печи: до 1800 K хватает купроникелевой (MV), до 2700 - кантала (HV),
 * до 3600 - нихрома (EV), горячее - IV и дальше.
 */
function mkTierByBlast(t) {
    if (!t || t <= 0) return 0
    if (t <= 1000) return 4
    if (t <= 1800) return 7
    if (t <= 2700) return 8
    if (t <= 3600) return 9
    return 10
}

// то, что в GregTech появляется поздно, как бы ни были устроены его свойства
const MK_LATE = /naquadah|neutronium|trinium|duranium|tritanium|europium|americium|plutonium|uranium|thorium|iridium|osmium|rhodium|ruthenium|samarium|darmstadtium|enriched|nuclear/

function mkMaterialInfo(mat) {
    var name = ""
    try { name = String(mat.getName()) } catch (e) { return null }
    if (MK_MAT[name]) return MK_MAT[name]
    var gt = mkGT()
    var info = { name: name, cls: "chem", tier: 3, value: 4, mat: mat }
    try {
        var hasIngot = gt && mat.hasProperty(gt.keys.INGOT)
        var hasGem = gt && mat.hasProperty(gt.keys.GEM)
        info.cls = hasIngot ? "metal" : hasGem ? "gem" : "chem"
        var tier = mkTierByBlast(Number(mat.getBlastTemperature()))
        if (!tier) {
            if (info.cls === "metal") tier = 3
            else if (mat.isElement()) {
                var p = Number(mat.getProtons())
                tier = p <= 20 ? 3 : p <= 30 ? 4 : p <= 56 ? 6 : p <= 83 ? 7 : 9
            } else tier = info.cls === "gem" ? 3 : 4
        }
        if (mat.isRadioactive()) tier = Math.max(tier, 9)
        if (MK_LATE.test(name)) tier = Math.max(tier, 9)
        info.tier = Math.max(1, Math.min(10, tier))
    } catch (e) { }
    var known = mkKnownMetal(name)
    if (known) { info.tier = known.tier; info.value = known.value; info.cls = "metal" }
    else info.value = MK_TIER_VALUE[info.tier] * (info.cls === "chem" ? 0.6 : 1)
    MK_MAT[name] = info
    return info
}

/** Материал и форма предмета по данным самого GregTech: {info, form, share} или null. */
function mkEntryOf(stack) {
    var gt = mkGT()
    if (!gt) return null
    try {
        var entry = gt.helper.getMaterialEntry(stack.getItem())
        if (!entry || entry.isEmpty()) return null
        var mat = entry.material()
        var prefix = entry.tagPrefix()
        if (!mat || !prefix) return null
        var info = mkMaterialInfo(mat)
        if (!info) return null
        var amount = Number(prefix.materialAmount())
        return { info: info, form: String(prefix.name), share: amount > 0 ? amount / MK_M : 1 }
    } catch (e) { return null }
}

// Когда GregTech не ответил (стенд или чужой предмет), узнаём материал по id
const MK_FORMS = /^([a-z0-9_]+?)_(dust|small_dust|tiny_dust|impure_dust|pure_dust|ingot|nugget|plate|double_plate|dense_plate|curved_plate|rod|long_rod|foil|gear|small_gear|ring|bolt|screw|spring|small_spring|round|rotor|wire_fine|frame|block|gem|flawless_gem|exquisite_gem|chipped_gem|flawed_gem|crushed_ore|purified_ore|refined_ore|raw_ore|ore)$/
const MK_FORM_SHARE = { dust: 1, small_dust: 0.25, tiny_dust: 0.11, impure_dust: 1, pure_dust: 1, ingot: 1, nugget: 0.11,
    plate: 1, double_plate: 2, dense_plate: 9, curved_plate: 1, rod: 0.5, long_rod: 1, foil: 0.25, gear: 4, small_gear: 1,
    ring: 0.25, bolt: 0.125, screw: 0.11, spring: 1, small_spring: 0.25, round: 0.11, rotor: 4, wire_fine: 0.125,
    frame: 2, block: 9, gem: 1, flawless_gem: 2, exquisite_gem: 4, chipped_gem: 0.25, flawed_gem: 0.5,
    crushed_ore: 1, purified_ore: 1, refined_ore: 1, raw_ore: 1, ore: 1 }
// что из химии стенд узнаёт без GregTech (тир)
const MK_CHEM_HINT = { potassium: 3, sodium: 3, calcium: 3, quicklime: 2, calcite: 2, saltpeter: 2, salt: 1, rock_salt: 1,
    sulfur: 2, phosphorus: 4, silicon: 5, lithium: 5, fluorine: 5, chlorine: 4, uranium: 9, uranium_235: 10,
    plutonium: 10, thorium: 9, carbon: 2, borax: 3, gypsum: 2, lapis: 2, redstone: 3, glowstone: 4 }

function mkEntryById(id) {
    var parts = String(id).split(":")
    if (parts.length < 2 || (parts[0] !== "gtceu" && parts[0] !== "tfg")) return null
    var m = parts[1].match(MK_FORMS)
    if (!m) return null
    var name = m[1], form = m[2]
    var known = mkKnownMetal(name)
    var info = MK_MAT[name]
    if (!info) {
        if (known) info = { name: name, cls: "metal", tier: known.tier, value: known.value }
        else if (MK_CHEM_HINT[name] !== undefined) {
            var t = MK_CHEM_HINT[name]
            info = { name: name, cls: "chem", tier: t, value: MK_TIER_VALUE[t] * 0.6 }
        } else if (/gem/.test(form)) info = { name: name, cls: "gem", tier: 3, value: MK_TIER_VALUE[3] }
        else info = { name: name, cls: form === "ingot" || form === "plate" || form === "rod" ? "metal" : "chem", tier: 4, value: MK_TIER_VALUE[4] }
    }
    return { info: info, form: form, share: MK_FORM_SHARE[form] || 1 }
}

// ─── Разметка по модам и словам в id ─────────────────────────────────────────

// [правило по id, кто берёт, цена по умолчанию в медяках]. Совпадения складываются.
const MK_RULES = [
    // мебель Macaw: деревянное - плотнику, каменное и металлическое - строителю
    [/^mcw_tfc_aio:.*(stone|brick|cobble|concrete|metal|iron|glass|marble|granite)/, ["builder"], 4],
    [/^mcw_tfc_aio:/, ["carpenter"], 6],
    // дороги, декор, крыши, разметка
    [/^(rnr|createdeco|framedblocks|domum_ornamentum|chalk|ags_modernmarkings|copycats|simplylight|alekiroofs|modern_markings)[:]/, ["builder"], 3],
    // механика, повозки, суда
    [/^(railways|create|create_connected|greate|vintageimprovements|create_factory_logistics|create_hypertube|create_picky_wheels|createaddition|create_sound_of_steam|cccbridge|tfcastikorcarts|firmaciv|alekiships|create_horse_power|create_stock_bridge|create_extra_gauges)[:]/, ["mechanic"], 8],
    // электрика, вычисления, космос
    [/^(ae2|megacells|expatternprovider|ae2wtlib|extendedae|ae2netanalyser|advancedperipherals|computercraft|morered|ad_astra|me_requester|gtmutils|gtceu_terminal|ae2iec|ae2na)[:]/, ["electrician"], 12],
    // звери, чудища и их трофеи
    [/^(iceandfire|wan_ancient_beasts|species|arthropocolypse|endermanoverhaul|primitive_creatures|sandworm)[:]/, ["hunter"], 5],
    // снаряжение из тех же модов - ещё и оружейнику с бронником
    [/^(iceandfire|wan_ancient_beasts|species)[:].*(sword|axe|spear|bow|arrow|macuahuitl|trident|lance|dagger|club|hammer)/, ["weaponsmith"], 12],
    [/^(iceandfire|wan_ancient_beasts|species)[:].*(armor|helmet|chestplate|leggings|boots)/, ["armorer"], 14],
    // еда, огород, пчёлы
    [/^(firmalife|afc|tfc_gourmet|tfclunchbox|water_flasks|tfcagedalcohol)[:].*(food|jar|jam|juice|wine|cheese|bread|pie|pizza|sugar|syrup|honey|chocolate|tea|coffee|alcohol|beer|cider)/, ["cook"], 3],
    [/^(firmalife|afc|tfc_gourmet)[:].*(seed|plant|sapling|bush|fruit|leaves|spice|herb|beehive|bee|planter)/, ["gardener"], 2],
    [/^(firmalife|afc)[:]/, ["gardener"], 3],
    // ткани, сумки, постель
    [/^(sophisticatedbackpacks|comforts|tfctextile|sns|toolbelt)[:]/, ["tailor"], 6],
    // приборы и мелочи
    [/^(exposure|etched|chimes|measurements|immersive_melodies|melody)[:]/, ["mechanic"], 6],
    // TFC, TFG, ванильное и подземное - по словам в id
    [/^(tfc|minecraft|tfg|beneath|afc)[:].*(log|planks|wood|stick|lumber|sapling|door|fence|trapdoor|chest|barrel|boat|sign|support|bookshelf|workbench|loom|sluice|shelf|scaffolding)/, ["carpenter"], 2],
    [/^(tfc|minecraft|tfg|beneath)[:].*(rock|stone|cobble|brick|slab|stairs|wall|gravel|sand|clay|glass|mortar|alabaster|marble|basalt|granite|diorite|andesite|deepslate|tuff|calcite|terracotta|concrete|quartz|prismarine|blackstone|dripstone)/, ["builder"], 1],
    [/^(tfc|minecraft|tfg|beneath)[:].*(seed|plant|flower|bush|crop|fruit|leaves|grass|moss|vine|mushroom|kelp|coral|cactus|reed|lily|fungus|root|straw|thatch)/, ["gardener"], 1],
    [/^(tfc|minecraft|tfg|beneath)[:].*(ore|raw_|crushed|nugget|powder|coal|coke|flux|gem|crystal|amethyst|diamond|emerald|lapis|redstone|obsidian)/, ["miner"], 2],
    [/^(tfc|minecraft|tfg)[:].*(ceramic|vessel|mold|jug|pot|crucible|kaolin|fire_clay|bowl|urn|brick_)/, ["potter"], 3],
    [/^(tfc|minecraft|tfg)[:].*(leather|hide|wool|cloth|string|thread|silk|jute|burlap|linen|fabric|bed|carpet|banner|wool)/, ["tailor"], 2],
    [/^(tfc|minecraft|tfg)[:].*(bone|feather|horn|fur|pelt|tallow|scute|skull|egg|ink|slime|web|spider_eye|gunpowder|blaze|ender|phantom|shulker)/, ["hunter"], 2],
    [/^(tfc|minecraft|tfg)[:].*(fish|meat|beef|pork|mutton|chicken|venison|rabbit|cod|salmon)/, ["butcher"], 2],
    [/^(tfc|minecraft|tfg)[:].*(metal|anvil|bell|chain|lamp|lantern|bars|rail|bucket|shears|tongs|chisel|hammer|saw|knife|cauldron|hopper|minecart)/, ["blacksmith"], 6],
    [/^(tfc|minecraft|tfg)[:].*(glass|bottle|flask|lens|jar)/, ["potter"], 2],
    [/^(tfg|minecraft)[:].*(pill|tablet|salve|salvo|potion|medicine|bandage|antidote)/, ["chemist"], 8],
    // оружие и боеприпасы TACZ
    [/^(tacz|applied_ammo_box)[:]/, ["weaponsmith"], 20],
    [/^tacz:.*(workbench|target|statue)/, ["mechanic"], 15],
    // летательное, крюки, жезлы, фонари-каски - механику
    [/^(immersive_aircraft|man_of_many_planes|grapplemod|hangglider|buildinggadgets2|constructionwand|diggerhelmet|parcool|astikorcarts|tfcgroomer|craftingstation|merequester|ae2insertexportcard)[:]/, ["mechanic"], 12],
    // литьё, клещи, скребки - кузнецу
    [/^(tfchotornot|tfcchannelcasting|tfcbetterbf|tfcscraping)[:]/, ["blacksmith"], 5],
    // фляги, одежда от холода, трости, котомки
    [/^(waterflasks|water_flasks|tfcambiental|tfccanes|tfclunchbox|firmacivplus)[:]/, ["tailor"], 4],
    [/^tfcagedalcohol[:]/, ["cook"], 4],
    // кухня tfc_gourmet: всё - повару, сырое мясо - ещё и мяснику
    [/^tfc_gourmet[:]/, ["cook"], 3],
    [/^tfc_gourmet[:].*(raw|meat|fish|sausage|bratwurst)/, ["butcher"], 3],
    // подземье
    [/^beneath[:].*(food|juice|juicer)/, ["cook"], 3],
    [/^beneath[:].*(pure|crystal|gold|ore|crackrack)/, ["miner"], 3],
    [/^beneath[:]/, ["builder"], 2],
    // TFC: лотки и залежи - шахтёру, стеклодувное - гончару, плетень и грунт - строителю
    [/^tfc:(pan|deposit)/, ["miner"], 3],
    [/^tfc:blowpipe/, ["potter"], 4],
    [/^tfc:(wattle|daub|groundcover|dirt|mud|farmland|aggregate|grass_path|rooted_dirt|clay_grass)/, ["builder"], 1],
    [/^tfc:(candle|compost|composter)/, ["gardener", "potter"], 2],
    [/^tfc:blubber/, ["hunter", "butcher"], 3],
    [/^tfc:(cake|food)/, ["cook"], 2],
    // ванильное: приборы механику, пластинки ему же, медь с воском строителю
    [/^minecraft:(clock|compass|recovery_compass|spyglass|music_disc|jukebox|note_block|observer|comparator|repeater|piston|daylight)/, ["mechanic"], 6],
    [/^minecraft:(waxed|oxidized|weathered|exposed|cut_copper|sculk|mud|packed|polished|smooth|chiseled|cracked)/, ["builder"], 1],
    [/^minecraft:(bamboo|warped|crimson|stripped|mangrove|cherry)/, ["carpenter"], 1],
    [/^minecraft:(netherite|golden|iron|diamond|chainmail|leather)_(helmet|chestplate|leggings|boots|horse_armor)/, ["armorer"], 12],
    [/^minecraft:(netherite|golden|iron|diamond|stone|wooden)_(sword|axe)/, ["weaponsmith"], 10],
    [/^minecraft:(netherite|golden|iron|diamond|stone|wooden)_(pickaxe|shovel|hoe)/, ["blacksmith"], 8],
    [/^minecraft:(crossbow|bow|trident|arrow|spectral_arrow|tipped_arrow)/, ["weaponsmith"], 8],
    [/^minecraft:(turtle|scute|nautilus|heart_of_the_sea|rabbit_hide|rabbit_foot)/, ["hunter"], 6],
]

// трофеи чудищ: цена выше средней, иначе драконья кость уходит за медяк
const MK_TROPHY = [
    [/dragon_?skull/, 120], [/dragon_heart/, 150], [/dragon.*blood|blood.*dragon/, 60], [/dragonsteel/, 200],
    [/dragonbone|dragon_bone/, 40], [/dragon_?scale/, 25], [/dragon_flesh|dragon_meat/, 12],
    [/sea_serpent_scale/, 18], [/troll_tusk/, 30], [/hydra/, 40], [/cockatrice_eye/, 25], [/siren_tear/, 30],
    [/pixie_dust/, 15], [/amphithere_feather/, 12], [/hippogryph_egg|hippocampus/, 50], [/myrmex/, 8],
    [/deathworm/, 20], [/cyclops_eye/, 45], [/gorgon_head/, 90], [/stymphalian/, 14],
]

// машины GregTech: по напряжению - механику (пар, LV, MV) или электрику (HV и выше)
const MK_VOLT = { steam: 1, lp_steam: 1, hp_steam: 2, ulv: 2, lv: 4, mv: 5, hv: 6, ev: 7, iv: 8, luv: 9, zpm: 10, uv: 10, uhv: 10 }

// ─── Главное: кто берёт и почём ──────────────────────────────────────────────

var MK_CLASSES = null

function mkClass(name) {
    if (!MK_CLASSES) {
        MK_CLASSES = {}
        var list = [
            ["armor", "net.minecraft.world.item.ArmorItem"],
            ["sword", "net.minecraft.world.item.SwordItem"],
            ["bow", "net.minecraft.world.item.ProjectileWeaponItem"],
            ["digger", "net.minecraft.world.item.DiggerItem"],
            ["block", "net.minecraft.world.item.BlockItem"],
        ]
        list.forEach(p => { try { MK_CLASSES[p[0]] = Java.loadClass(p[1]) } catch (e) { } })
    }
    return MK_CLASSES[name] || null
}

/** Кто из торговцев возьмёт эту вещь, и её честная цена за штуку в медяках. */
function mkAppraise(stack) {
    var out = { kinds: [], value: 0, why: [] }
    if (!stack) return out
    var id = String(stack.id)
    var add = (kinds, value, why) => {
        kinds.forEach(k => { if (out.kinds.indexOf(k) < 0) out.kinds.push(k) })
        if (value > out.value) out.value = value
        if (why) out.why.push(why)
    }

    // 0. гардероб (factions/wardrobe_prices.js): одежда - только портному (не броннику, хоть это и «броня»),
    // украшения - кузнецу, портному и шахтёру, короны - кузнецу и портному; скупщик берёт их дороже всех
    var wp = null
    try { wp = global.TFG_WARDROBE_PRICE(id) } catch (e) { }
    if (wp) {
        add(wp.kinds, wp.value, wp.kind === "cloth" ? "одежда" : "украшение")
        return out
    }

    // 1. материал GregTech
    var entry = mkEntryOf(stack) || mkEntryById(id)
    if (entry) {
        var price = TG_UNIT * entry.info.value * entry.share
        var ore = /ore|crushed|raw|impure|pure/.test(entry.form)
        if (ore) add(["miner"], price * 0.7, "руда " + entry.info.name)
        else if (entry.info.cls === "metal") add(["metallurgist"], price, "металл " + entry.info.name + " (тир " + entry.info.tier + ")")
        else if (entry.info.cls === "gem") add(["miner", "metallurgist"], price, "самоцвет " + entry.info.name)
        else add(["chemist"], price, "химия " + entry.info.name + " (тир " + entry.info.tier + ")")
    }

    // 2. машины и детали GregTech
    var gm = id.match(/^(gtceu|tfg):([a-z_]+?)_/)
    if (gm && MK_VOLT[gm[2]] !== undefined) {
        var vt = MK_VOLT[gm[2]]
        add([vt >= 6 ? "electrician" : "mechanic"], TG_UNIT * MK_TIER_VALUE[vt] * 3, "машина " + gm[2])
    } else if (/^(gtceu|tfg):.*(circuit|board|wafer|chip|processor|mainframe|transistor|resistor|capacitor|diode|inductor|smd)/.test(id)) {
        add(["electrician"], TG_UNIT * 6, "электроника")
    } else if (/^(gtceu|tfg):.*(motor|pump|piston|conveyor|robot_arm|emitter|sensor|field_generator|casing|hull|coil|pipe|cable|wire)/.test(id)) {
        add(["mechanic", "electrician"], TG_UNIT * 4, "деталь машины")
    } else if (/^(gtceu|tfg):/.test(id) && !entry) {
        add(["mechanic"], TG_UNIT * 2, "изделие GregTech")
    }

    // 3. моды и слова в id
    MK_RULES.forEach(r => { if (r[0].test(id)) add(r[1], r[2], null) })
    MK_TROPHY.forEach(t => { if (t[0].test(id)) add(["hunter"], t[1], "трофей") })

    // 4. сама вещь: еда, броня, оружие, инструмент, блок
    try {
        var item = stack.getItem()
        var cls = mkClass("armor")
        if (cls && item instanceof cls) add(["armorer"], 14, "броня")
        cls = mkClass("sword")
        if (cls && item instanceof cls) add(["weaponsmith"], 12, "клинок")
        cls = mkClass("bow")
        if (cls && item instanceof cls) add(["weaponsmith", "hunter"], 10, "стрелковое")
        cls = mkClass("digger")
        if (cls && item instanceof cls) add(["blacksmith"], 8, "инструмент")
        if (item.isEdible && item.isEdible()) add(["cook"], 2, "еда")
        cls = mkClass("block")
        if (!out.kinds.length && cls && item instanceof cls) add(["builder"], 1, "блок")
    } catch (e) { }

    return out
}

/** Возьмёт ли этот вид торговца вещь по разметке рынка. */
function mkBuys(kindId, stack) {
    return mkAppraise(stack).kinds.indexOf(kindId) >= 0
}

/** Старьёвщик: берёт всё, но задёшево. */
function mkJunkPrice(stack) {
    var a = mkAppraise(stack)
    return Math.max(MK_JUNK_MIN, a.value * MK_JUNK_SHARE)
}

/**
 * Скупщик: только драгоценное - самоцветы любой огранки, драгметаллы в любой форме,
 * украшения и камни других модов. Платит больше любого профильного торговца: за этим
 * к нему и идут. 0 - не его товар.
 */
function mkPreciousPrice(stack) {
    var id = String(stack.id)
    var entry = mkEntryOf(stack) || mkEntryById(id)
    var precious = false
    if (entry && !/ore|crushed|raw|impure|pure/.test(entry.form)) {
        precious = entry.info.cls === "gem" || MK_PRECIOUS_METALS.test(entry.info.name)
    }
    if (!precious && MK_PRECIOUS_WORDS.test(id)) precious = true
    var wp = null
    try { wp = global.TFG_WARDROBE_PRICE(id) } catch (e) { }
    if (wp) precious = wp.kind !== "cloth"          // тиары - тоже; венок из цветов и наряды - нет
    if (!precious) return 0
    var a = mkAppraise(stack)
    // Самоцвет другого мода ценится как такой же самоцвет GregTech: алмаз - алмаз,
    // топаз TFC - топаз. Иначе он уходил бы по цене случайной безделушки.
    var gem = mkGemValue(id)
    return Math.max(1, Math.max(a.value, gem) * MK_PRECIOUS_MARKUP)
}

// самоцвет по имени в id: tfc:gem/topaz, minecraft:diamond, iceandfire:sapphire_gem
const MK_GEM_NAMES = /(diamond|emerald|ruby|sapphire|green_sapphire|topaz|blue_topaz|amethyst|amythest|opal|red_garnet|yellow_garnet|garnet|jade|lapis|pearl)/
function mkGemValue(id) {
    var m = String(id).match(MK_GEM_NAMES)
    if (!m) return 0
    var name = m[1] === "amythest" ? "amethyst" : m[1] === "garnet" ? "red_garnet" : m[1]
    var base = 0
    try { base = TG_GEMS[name] || 0 } catch (e) { }
    if (!base) base = 0.8
    // огранка: цельный камень = 25 единиц за штуку, как у скупщика в trade_goods.js
    var grade = /exquisite/.test(id) ? 150 : /flawless/.test(id) ? 60 : /flawed/.test(id) ? 10 : /chipped/.test(id) ? 5 : 25
    if (/(^|[:_\/])(block|ore)([_\/]|$)/.test(id)) grade = /ore/.test(id) ? 12 : 225
    return grade * base
}

// ─── Что продают химик и металлург ───────────────────────────────────────────

var MK_INDEX = null                  // все материалы GregTech с их классом и тиром

function mkIndex() {
    if (MK_INDEX) return MK_INDEX
    MK_INDEX = []
    var gt = mkGT()
    if (!gt) return MK_INDEX
    try {
        var it = gt.api.materialManager.getRegisteredMaterials().iterator()
        while (it.hasNext()) {
            var mat = it.next()
            var info = mkMaterialInfo(mat)
            if (info) MK_INDEX.push(info)
        }
        mkLog("материалов GregTech размечено: " + MK_INDEX.length + " (металлов " +
            MK_INDEX.filter(x => x.cls === "metal").length + ", химии " + MK_INDEX.filter(x => x.cls === "chem").length +
            ", самоцветов " + MK_INDEX.filter(x => x.cls === "gem").length + ")")
    } catch (e) { mkErr("перечень материалов", e) }
    return MK_INDEX
}

/** Предмет «форма + материал» от самого GregTech: так выходят и материалы TFG, у которых свой id. */
function mkItemOf(info, formName) {
    var gt = mkGT()
    if (!gt || !info.mat) return null
    try {
        var prefix = gt.prefix[formName]
        if (!prefix) return null
        var st = gt.helper.get(prefix, info.mat, 1)
        if (!st || st.isEmpty()) return null
        return String(st.id)
    } catch (e) { return null }
}

// партия и запас: металлург торгует оптом, химик - понемногу
function mkLot(id, count, unitValue, stock) {
    return { item: id, count: count, price: Math.max(1, Math.round(TG_UNIT * unitValue * count * 1.15)), stock: stock }
}

/**
 * Металлург: слитки и прокат всех металлов своего тира и ниже. Тем, чего нет у кузнеца,
 * - высокими тирами и сложными сплавами - торгует именно он. Слитки идут оптом.
 * Самое свежее для игрока (высший доступный тир) стоит в начале списка.
 */
function mkMetallurgist(tier) {
    var out = []
    var metals = mkIndex().filter(x => x.cls === "metal" && x.tier <= tier)
    if (!metals.length) {
        // GregTech не ответил: хотя бы то, что оценено вручную
        try { metals = TG_METALS.filter(m => m.tier <= tier).map(m => ({ name: m.id, cls: "metal", tier: m.tier, value: m.value })) } catch (e) { }
    }
    metals.sort((a, b) => b.tier - a.tier || b.value - a.value)
    metals.forEach(m => {
        var ingot = mkItemOf(m, "ingot") || ("gtceu:" + m.name + "_ingot")
        out.push(mkLot(ingot, 16, m.value, 6))                     // оптом: по 16 слитков, шесть партий
        if (m.tier >= tier - 2) {
            var plate = mkItemOf(m, "plate") || ("gtceu:" + m.name + "_plate")
            var rod = mkItemOf(m, "rod") || ("gtceu:" + m.name + "_rod")
            var foil = mkItemOf(m, "foil") || ("gtceu:" + m.name + "_foil")
            out.push(mkLot(plate, 8, m.value * 1.1, 3))
            out.push(mkLot(rod, 8, m.value * 0.55, 3))
            out.push(mkLot(foil, 16, m.value * 0.3, 2))
        }
    })
    return out
}

/**
 * Химик: порошки материалов без слитка - соли, щёлочи, чистые элементы. На раннем тире
 * это известь, селитра и сера; чистый калий - с третьего; уран, торий и прочая
 * радиоактивность - только с девятого.
 */
function mkChemist(tier) {
    var out = []
    var chems = mkIndex().filter(x => x.cls === "chem" && x.tier <= tier)
    if (!chems.length) {
        for (var n in MK_CHEM_HINT) {
            if (MK_CHEM_HINT[n] > tier) continue
            chems.push({ name: n, cls: "chem", tier: MK_CHEM_HINT[n], value: MK_TIER_VALUE[MK_CHEM_HINT[n]] * 0.6 })
        }
    }
    chems.sort((a, b) => b.tier - a.tier || b.value - a.value)
    chems.forEach(c => {
        var dust = mkItemOf(c, "dust") || ("gtceu:" + c.name + "_dust")
        var count = c.value > 20 ? 1 : c.value > 6 ? 4 : 8
        out.push(mkLot(dust, count, c.value, c.tier >= 8 ? 1 : 3))
    })
    return out
}

// ─── Встраиваемся в список торговцев ─────────────────────────────────────────

try {
    TG_KINDS.push({ id: "metallurgist", name: "Металлург", minTier: 2, goods: mkMetallurgist, buys: [] })
    TG_KINDS.push({ id: "chemist", name: "Химик", minTier: 3, goods: mkChemist, buys: [] })
    // старьёвщик ничего не продаёт - только берёт что угодно, задёшево
    TG_KINDS.push({ id: "junk", name: "Старьёвщик", minTier: 1, special: true })
} catch (e) { mkErr("новые торговцы", e) }

global.TFG_MARKET = {
    appraise: stack => mkAppraise(stack),
    buys: (kindId, stack) => mkBuys(kindId, stack),
    junk: stack => mkJunkPrice(stack),
    precious: stack => mkPreciousPrice(stack),
    index: () => mkIndex(),
}

// ─── Разбор на месте: /tfgmarket - кто возьмёт то, что в руке ────────────────

ServerEvents.commandRegistry(event => {
    try {
        var Commands = event.commands
        event.register(Commands.literal("tfgmarket").requires(s => s.hasPermission(2)).executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            var st = p.getMainHandItem()
            if (!st || st.isEmpty()) { ctx.source.sendFailure(Text.of("Возьмите вещь в руку.")); return 1 }
            var a = mkAppraise(st)
            var rows = ["§f" + st.id, "§7кто берёт: " + (a.kinds.length ? a.kinds.join(", ") : "только скупщик"),
                "§7цена: " + a.value.toFixed(2) + " мед., у скупщика " + mkPreciousPrice(st).toFixed(2) +
                    ", у старьёвщика " + mkJunkPrice(st).toFixed(2),
                "§7почему: " + (a.why.join("; ") || "по моду или слову в id")]
            ctx.source.sendSuccess(Text.of(rows.join("\n")), false)
            return 1
        }))
    } catch (err) {
        console.error("[рынок] ошибка регистрации команд: " + err)
    }
})
