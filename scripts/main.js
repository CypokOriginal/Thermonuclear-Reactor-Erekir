// Главный скрипт — запускает систему скриптов
print("Скрипты загружены!");

// Подключаем остальные скрипты
// test-script отключён: этого файла нет в папке scripts,
// а первая же ошибка require останавливает весь main.js.
// require("test-script");
require("magnum-ignis");
require("httr");
require("lustre-helium");
