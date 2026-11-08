// magnum-ignis.js - гелий из термоядерной реакции Magnum Ignis.
//
// Реактор остаётся ванильным типом ImpactReactor: зажигание, разгон, мощность и встроенный взрыв
// на всю карту при разрушении (если реактор разогрет хотя бы на 30%) делает сама игра.
// Скрипт добавляет только то, чего у ImpactReactor нет:
//   1) в ходе реакции из водорода получается гелий: 2 водорода -> 1 гелий, 126 -> 63 в секунду
//      на полной мощности, при неполной - пропорционально мощности;
//   2) гелий охлаждает магниты реактора и выводится в соседние блоки (трубы, газоохлаждаемый реактор);
//   3) если гелию некуда уходить и бак заполнился, реактор разрушается - и игра сама его взрывает;
//   4) у реактора появляется полоска гелия, чтобы было видно, как заполняется бак.
// Жидкости в игре перетекают из более заполненного бака в менее заполненный (по доле, а не по объёму),
// поэтому гелию нужен сток не меньше выработки: потребители и/или открытая труба (гелий - газ,
// он просто уходит в атмосферу). Если всё ниже по трубам полно, бак реактора заполнится.
//
// Нагрузка: скрипт смотрит только на реакторы Magnum Ignis (списки построек игра ведёт сама).
// ВАЖНО для Rhino игры: поле закрывает метод с тем же именем, поэтому b.block, b.liquids,
// b.productionEfficiency - поля; b.isValid(), b.kill(), b.dumpLiquid() - методы.
// Любая ошибка пишется в last_log.txt и не роняет игру; после MAX_ERRORS ошибок скрипт отключается.

const BLOCK_NAME = "termoatom-magnum-ignis-reactor";
const HELIUM_NAME = "termoatom-helium";

const HELIUM_PER_TICK = 63 / 60;   // гелий за тик на полной мощности
const MAX_ERRORS = 5;

let block = null;
let helium = null;
let errors = 0;
let disabled = false;

function guard(where, fn){
    if(disabled) return;
    try{
        fn();
    }catch(e){
        errors++;
        Log.err("[magnum-ignis] Ошибка скрипта (" + where + "): " + e);
        if(errors >= MAX_ERRORS){
            disabled = true;
            Log.err("[magnum-ignis] Скрипт гелия отключён после " + MAX_ERRORS + " ошибок. Игра продолжит работу без него.");
            try{
                if(!Vars.headless && Vars.ui != null) Vars.ui.announce("[scarlet]Magnum Ignis: выработка гелия отключена из-за ошибки скрипта, см. last_log.txt");
            }catch(ignored){}
        }
    }
}

function resolve(){
    if(block == null) block = Vars.content.block(BLOCK_NAME);
    if(helium == null) helium = Vars.content.liquid(HELIUM_NAME);
    return block != null && helium != null;
}

function collectReactors(){
    const result = [];
    const teams = Vars.state.teams.present;
    for(let t = 0; t < teams.size; t++){
        const list = teams.get(t).getBuildings(block);
        for(let i = 0; i < list.size; i++) result.push(list.get(i));
    }
    return result;
}

function update(){
    if(!Vars.state.isGame() || Vars.state.isPaused() || Vars.net.client()) return;
    if(!resolve()) return;

    const capacity = block.liquidCapacity;
    const reactors = collectReactors();

    for(let i = 0; i < reactors.length; i++){
        const b = reactors[i];
        if(b == null || !b.isValid() || b.block != block) continue;
        const liquids = b.liquids;
        if(liquids == null) continue;

        // 1) сначала выводим гелий в соседние блоки (сколько они готовы принять)
        if(liquids.get(helium) > 0.001) b.dumpLiquid(helium);

        // 2) гелий от реакции, пропорционально текущей мощности
        const made = HELIUM_PER_TICK * b.productionEfficiency * Time.delta;
        if(made <= 0) continue;

        // 3) новому гелию нет места: ему некуда уходить, магниты перегреваются, реакция срывается.
        //    Проверка именно здесь, иначе при слабом стоке лишний гелий молча терялся бы, а бак
        //    стоял бы почти полным без взрыва.
        const room = capacity - liquids.get(helium);
        if(made > room){
            Log.info("[magnum-ignis] Реактор в (" + b.tileX() + ", " + b.tileY() + ") разрушен: бак гелия переполнен");
            b.kill();
            continue;
        }

        liquids.add(helium, made);
    }
}

// Полоска гелия в окне реактора (бары - это интерфейс, поэтому только у игрока, не на сервере).
Events.on(ClientLoadEvent, () => guard("полоска гелия", () => {
    if(resolve()) block.addLiquidBar(helium);
}));

Events.run(Trigger.update, () => guard("гелий реактора", update));

print("magnum-ignis: выработка гелия подключена");
