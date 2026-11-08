// httr.js - взрыв Газоохлаждаемого ядерного реактора (блок httr из библиотеки MultiCrafter).
//
// Реактор взрывается, если:
//   1) он разогрет и ему не хватает гелия дольше STARVE_TICKS (потеря теплоносителя);
//   2) бак шлака заполнен до конца (отработанное топливо некуда сливать);
//   3) бак водорода заполнен до конца (водород некуда девать, режим "Энергия и водород").
// Без гелия холодный реактор не запускается и не взрывается: при постройке ничего не случится.
// Расход гелия берётся из выбранного режима (рецепта), поэтому в обоих режимах проверка честная.
//
// Производительность: скрипт НЕ перебирает все постройки карты. Игра сама ведёт список построек
// каждого типа для каждой команды (TeamData.getBuildings), скрипт каждый кадр смотрит только
// на реакторы httr. Нагрузка не зависит от размера базы.
//
// ВАЖНО для скриптов Mindustry: в Rhino игры поле ВСЕГДА закрывает метод с тем же именем
// (Anuken/rhino, JavaMembers.java: "fields will always mask methods").
// Поэтому у построек пишем поля: b.block, b.liquids, b.warmup, b.x, b.y, b.id, b.currentRecipe.
// Методы вызываем только там, где поля с таким именем нет: b.tileX(), b.isValid(), b.kill().
//
// Любая ошибка внутри скрипта пишется в last_log.txt и НЕ роняет игру.
// После MAX_ERRORS ошибок контроль взрыва отключается до перезапуска.

const BLOCK_NAME = "termoatom-httr";
const HELIUM_NAME = "termoatom-helium";

// ---- Настройки ----
const DEFAULT_HELIUM_PER_TICK = 40 / 60;  // если рецепт почему-то не выбран
const HOT_WARMUP = 0.5;            // реактор считается разогретым, если warmup выше (0..1)
const STARVE_TICKS = 30;           // сколько тиков он выдерживает без гелия (60 тиков = 1 с)
const EXPLOSION_RADIUS = 30;       // радиус взрыва в тайлах
const EXPLOSION_DAMAGE = 5000;     // урон в центре взрыва
const SLAG_PUDDLES = 12;           // сколько луж шлака разбросает взрыв
const SLAG_PER_PUDDLE = 100;
const MAX_ERRORS = 5;

let block = null;
let helium = null;
let starve = {};      // id постройки -> сколько тиков ей не хватает гелия
let errors = 0;
let disabled = false;

function guard(where, fn){
    if(disabled) return;
    try{
        fn();
    }catch(e){
        errors++;
        Log.err("[httr] Ошибка скрипта (" + where + "): " + e);
        if(errors >= MAX_ERRORS){
            disabled = true;
            Log.err("[httr] Контроль взрыва отключён после " + MAX_ERRORS + " ошибок. Игра продолжит работу без него.");
            try{
                if(!Vars.headless && Vars.ui != null) Vars.ui.announce("[scarlet]Газоохлаждаемый реактор: контроль взрыва отключён из-за ошибки скрипта, см. last_log.txt");
            }catch(ignored){}
        }
    }
}

function resolve(){
    if(block == null) block = Vars.content.block(BLOCK_NAME);
    if(helium == null) helium = Vars.content.liquid(HELIUM_NAME);
    return block != null && helium != null;
}

// Все реакторы httr всех команд. Сначала собираем в массив, потом проверяем:
// взрыв меняет списки игры, менять их во время обхода нельзя.
function collectReactors(){
    const result = [];
    const teams = Vars.state.teams.present;
    for(let t = 0; t < teams.size; t++){
        const list = teams.get(t).getBuildings(block);
        for(let i = 0; i < list.size; i++) result.push(list.get(i));
    }
    return result;
}

// Сколько гелия за тик требует выбранный режим.
function heliumNeed(b){
    const recipe = b.currentRecipe;
    if(recipe == null) return DEFAULT_HELIUM_PER_TICK;
    const stacks = recipe.input.liquids;
    if(stacks == null) return DEFAULT_HELIUM_PER_TICK;
    for(let i = 0; i < stacks.length; i++){
        if(stacks[i].liquid == helium) return stacks[i].amount;
    }
    return 0;   // режим без гелия: проверку нехватки не делаем
}

function effects(x, y){
    try{
        Fx.reactorExplosion.at(x, y);
        Effect.shake(6, 30, x, y);
        if(Sounds.explosionReactor != null) Sounds.explosionReactor.at(x, y);
    }catch(e){
        Log.err("[httr] Ошибка эффектов взрыва: " + e);
    }
}

function meltdown(b, reason){
    const x = b.x, y = b.y, tx = b.tileX(), ty = b.tileY();
    Log.info("[httr] Взрыв реактора в (" + tx + ", " + ty + "): " + reason);

    try{
        if(Vars.state.rules.reactorExplosions){
            Damage.damage(x, y, EXPLOSION_RADIUS * Vars.tilesize, EXPLOSION_DAMAGE);

            const spread = Math.max(1, Math.round(EXPLOSION_RADIUS / 4));
            for(let i = 0; i < SLAG_PUDDLES; i++){
                const t = Vars.world.tile(
                    tx + Math.round((Math.random() * 2 - 1) * spread),
                    ty + Math.round((Math.random() * 2 - 1) * spread)
                );
                if(t != null) Puddles.deposit(t, Liquids.slag, SLAG_PER_PUDDLE);
            }
        }
        effects(x, y);
    }finally{
        // постройка разрушается в любом случае, даже если урон или эффекты дали ошибку
        b.kill();
    }
}

function check(){
    if(!Vars.state.isGame() || Vars.state.isPaused() || Vars.net.client()) return;
    if(!resolve()) return;

    const reactors = collectReactors();
    const capacity = block.liquidCapacity;
    const next = {};   // счётчики только для живых реакторов: старые записи пропадают сами

    for(let i = 0; i < reactors.length; i++){
        const b = reactors[i];
        if(b == null || !b.isValid() || b.block != block) continue;

        const liquids = b.liquids;
        if(liquids == null) continue;
        const key = b.id;

        // 1) шлак забился
        if(liquids.get(Liquids.slag) >= capacity - 0.01){
            meltdown(b, "бак шлака переполнен");
            continue;
        }

        // 2) водород некуда девать
        if(liquids.get(Liquids.hydrogen) >= capacity - 0.01){
            meltdown(b, "бак водорода переполнен");
            continue;
        }

        // 3) не хватает гелия на разогретом реакторе
        const need = heliumNeed(b);
        let t = starve[key] || 0;
        const lacking = need > 0 && liquids.get(helium) < need;

        if(lacking && (b.warmup > HOT_WARMUP || t > 0)){
            t += Time.delta;
        }else{
            t = 0;
        }

        if(t >= STARVE_TICKS){
            meltdown(b, "не хватает гелия");
            continue;
        }

        if(t > 0) next[key] = t;
    }

    starve = next;
}

Events.on(WorldLoadEvent, () => guard("загрузка карты", () => {
    starve = {};
}));

Events.run(Trigger.update, () => guard("проверка реакторов", check));

print("httr: контроль взрыва подключён");
