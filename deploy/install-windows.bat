@echo off
rem ============================================================
rem  财务管理台 · Windows Server 安装脚本
rem  用法：在项目根目录（含 server\ 的那一层）右键「以管理员身份运行」
rem  作用：构建前端 → 用 nssm 注册为 Windows 服务并启动
rem  没有 nssm 时会退回「计划任务开机自启」方案
rem ============================================================
setlocal enabledelayedexpansion
chcp 65001 >nul

rem 定位源码目录。两种形态都要支持：
rem   仓库形态：  <项目根>\server\{server.js,deploy\}   —— 脚本在 server\deploy\ 下
rem   发布包形态：<解包目录>\{server.js,deploy\}         —— 打包时已去掉 server\ 这一层
rem 早先只认第一种，从 zip 解出来直接跑会找不到 server.js。
pushd "%~dp0.." || (echo 无法进入上级目录 & pause & exit /b 1)
set "SERVER_DIR=%CD%"
popd
if not exist "%SERVER_DIR%\server.js" (
  pushd "%~dp0..\..\server" 2>nul || (echo [错误] 找不到 server.js，请在解包目录内执行 deploy\install-windows.bat & pause & exit /b 1)
  set "SERVER_DIR=%CD%"
  popd
)
if not exist "%SERVER_DIR%\server.js" (
  echo [错误] 找不到 server.js。请在解包目录内执行：deploy\install-windows.bat
  pause & exit /b 1
)
set "SERVICE_NAME=FinConsole"
set "DATA_DIR=%ProgramData%\FinConsole"

echo.
echo === 财务管理台 Windows 部署 ===
echo 程序目录：%SERVER_DIR%
echo 数据目录：%DATA_DIR%
echo.

rem --- 1) 检查 Node ---
for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%n"
if not defined NODE_EXE (
  echo [错误] 未找到 Node.js。请先安装 Node 22 LTS：https://nodejs.org/
  pause & exit /b 1
)
for /f "delims=" %%v in ('"%NODE_EXE%" -p "process.versions.node"') do set "NODE_VER=%%v"
for /f "tokens=1,2 delims=." %%a in ("!NODE_VER!") do (set "NMAJ=%%a" & set "NMIN=%%b")
if !NMAJ! LSS 22 (
  echo [错误] Node 版本过低（当前 v!NODE_VER!），需要 22.5 以上。
  pause & exit /b 1
)
if !NMAJ!==22 if !NMIN! LSS 5 (
  echo [错误] Node 版本过低（当前 v!NODE_VER!），需要 22.5 以上。
  pause & exit /b 1
)
"%NODE_EXE%" -e "require('node:sqlite')" >nul 2>nul || (
  echo [错误] 当前 Node 不支持 node:sqlite，请安装官方 Node 22 LTS。
  pause & exit /b 1
)
echo [1/4] Node 检查通过：v!NODE_VER!

rem --- 2) 构建前端：把 frontend\ 复制成 public\，再做两道校验 ---
echo [2/4] 构建前端
pushd "%SERVER_DIR%"
"%NODE_EXE%" scripts\build-frontend.mjs || (echo [错误] 前端构建失败 & popd & pause & exit /b 1)
"%NODE_EXE%" scripts\check-esm.mjs || (echo [错误] 模块图校验失败 & popd & pause & exit /b 1)
"%NODE_EXE%" scripts\verify-build.mjs || (echo [错误] 产物校验失败 & popd & pause & exit /b 1)
popd

rem --- 3) 准备数据目录与配置 ---
if not exist "%DATA_DIR%\backups" (
  mkdir "%DATA_DIR%\backups" || (echo [错误] 创建数据目录失败 & pause & exit /b 1)
)
if not exist "%SERVER_DIR%\config.json" (
  copy /y "%SERVER_DIR%\config.example.json" "%SERVER_DIR%\config.json" >nul || (echo [错误] 创建 config.json 失败 & pause & exit /b 1)
  powershell -NoProfile -Command "$p='%SERVER_DIR%\config.json'; $c=Get-Content -Raw -LiteralPath $p; $c=$c -replace '\"dataDir\": \"data\"', '\"dataDir\": \"%DATA_DIR:\=\\%\"'; Set-Content -LiteralPath $p -Value $c -Encoding UTF8" || (echo [错误] 写入数据目录配置失败 & pause & exit /b 1)
  echo     已生成 config.json，可按需修改 orgName / host / port
)
powershell -NoProfile -Command "Get-Content -Raw -LiteralPath '%SERVER_DIR%\config.json' | ConvertFrom-Json | Out-Null" || (echo [错误] 读取 config.json 失败 & pause & exit /b 1)
for /f "usebackq delims=" %%h in (`powershell -NoProfile -Command "$c=Get-Content -Raw -LiteralPath '%SERVER_DIR%\config.json' ^| ConvertFrom-Json; Write-Output $c.host"`) do set "FIN_HOST=%%h"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "$c=Get-Content -Raw -LiteralPath '%SERVER_DIR%\config.json' ^| ConvertFrom-Json; Write-Output $c.port"`) do set "FIN_PORT=%%p"
if not defined FIN_HOST set "FIN_HOST=127.0.0.1"
if not defined FIN_PORT set "FIN_PORT=8787"
echo [3/4] 数据目录就绪

rem --- 4) 注册服务 ---
where nssm >nul 2>nul
if %ERRORLEVEL%==0 goto use_nssm

echo [4/4] 未检测到 nssm，改用计划任务实现开机自启
schtasks /query /tn "%SERVICE_NAME%" >nul 2>nul
if not errorlevel 1 schtasks /delete /tn "%SERVICE_NAME%" /f >nul || (echo [错误] 删除旧计划任务失败 & pause & exit /b 1)
schtasks /create /tn "%SERVICE_NAME%" /tr "\"%NODE_EXE%\" \"%SERVER_DIR%\server.js\"" /sc onstart /ru SYSTEM /rl highest /f >nul || (
  echo [错误] 创建计划任务失败 & pause & exit /b 1
)
schtasks /run /tn "%SERVICE_NAME%" >nul || (echo [错误] 启动计划任务失败 & pause & exit /b 1)
echo     已创建并启动计划任务 %SERVICE_NAME%
echo     停止服务： schtasks /end /tn "%SERVICE_NAME%"
goto done

:use_nssm
echo [4/4] 用 nssm 注册 Windows 服务
nssm stop "%SERVICE_NAME%" >nul 2>nul
nssm remove "%SERVICE_NAME%" confirm >nul 2>nul
nssm install "%SERVICE_NAME%" "%NODE_EXE%" "server.js" || (echo [错误] nssm install 失败 & pause & exit /b 1)
nssm set "%SERVICE_NAME%" AppDirectory "%SERVER_DIR%" || (echo [错误] 设置服务目录失败 & pause & exit /b 1)
nssm set "%SERVICE_NAME%" DisplayName "财务管理台" || (echo [错误] 设置服务名称失败 & pause & exit /b 1)
nssm set "%SERVICE_NAME%" Description "多模块财务台账服务端" || (echo [错误] 设置服务描述失败 & pause & exit /b 1)
nssm set "%SERVICE_NAME%" Start SERVICE_AUTO_START || (echo [错误] 设置服务启动方式失败 & pause & exit /b 1)
nssm set "%SERVICE_NAME%" AppStdout "%DATA_DIR%\service.log" || (echo [错误] 设置标准输出日志失败 & pause & exit /b 1)
nssm set "%SERVICE_NAME%" AppStderr "%DATA_DIR%\service.log" || (echo [错误] 设置标准错误日志失败 & pause & exit /b 1)
nssm set "%SERVICE_NAME%" AppRotateFiles 1 || (echo [错误] 设置日志轮转失败 & pause & exit /b 1)
nssm set "%SERVICE_NAME%" AppRotateBytes 10485760 || (echo [错误] 设置日志大小失败 & pause & exit /b 1)
nssm start "%SERVICE_NAME%" || (echo [错误] 服务启动失败，请查看 %DATA_DIR%\service.log & pause & exit /b 1)
echo     服务已启动

:done
echo.
echo === 部署完成 ===
echo 访问地址：http://%FIN_HOST%:%FIN_PORT%
echo.
echo 要让同事从局域网访问，两步：
echo   1) 编辑 %SERVER_DIR%\config.json，把 "host" 改为 "0.0.0.0"
echo   2) 放行防火墙： netsh advfirewall firewall add rule name="财务管理台" dir=in action=allow protocol=TCP localport=8787
echo      然后重启服务
echo.
echo 首次启动生成的管理员口令在日志里：
echo   %DATA_DIR%\service.log   （nssm 方案）
echo 忘记口令时重置：
echo   cd /d "%SERVER_DIR%" ^&^& node scripts\reset-password.mjs admin
echo   （交互式隐藏输入，不要把口令写在命令行参数里）
echo.
pause
