# Проверка подключения к базе 1С внешним соединением (V83.COMConnector).
#
# Строка соединения приходит в P1C_CONN, вердикт пишется JSON-файлом в P1C_OUT:
#   { ok, version, error }
# Пароль по командной строке не ходит: он остаётся в переменных окружения
# процесса, который живёт доли секунды. Файл результата — чтобы не зависеть от
# кодовой страницы консоли (иначе кириллица платформы приезжает мусором).
#
# Почему не Конфигуратор: /CheckConfig читает и проверяет конфигурацию целиком,
# /DumpCfg пишет файл размером с конфигурацию и блокирует её. Внешнее соединение
# только авторизуется и открывает базу на чтение.

$ErrorActionPreference = 'Stop'
$connStr = $env:P1C_CONN
$outFile = $env:P1C_OUT

$ok = $false
$version = ''
$errorText = ''
$connector = $null
$connection = $null

try {
    $connector = New-Object -ComObject V83.COMConnector
    $connection = $connector.Connect($connStr)
    $ok = $true
    try {
        $version = [string]$connection.Метаданные.Версия
    } catch {
        # Версия может быть не задана в конфигурации либо не читаться из-за
        # библиотеки типов — соединение от этого не перестаёт быть успешным.
        $version = ''
    }
} catch {
    $errorText = $_.Exception.Message
} finally {
    if ($null -ne $connection) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($connection) }
    if ($null -ne $connector) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($connector) }
    [GC]::Collect()
}

$payload = [ordered]@{
    ok = $ok
    version = $version
    error = $errorText
}
$json = $payload | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding $false))
