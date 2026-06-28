@echo off
REM PowerShell script to fund all user wallets in the database
REM Usage: fund_all_wallets.bat [amount] [token_type]
REM   amount: Amount to fund each wallet (default: 1.0)
REM   token_type: "sol" for SOL, "usdc" for USDC (default: sol)

REM Set error action preference
SetLocal EnableDelayedExpansion

REM Load environment variables from .env file if it exists
if exist "..\.env" (
    for /f "tokens=1 delims==" %%i in (..\.env) do (
        set "varname=%%i"
        set "varvalue="
        for /f "delims=" %%j in ('findstr /R "^%%i=.*" ..\.env') do set "varvalue=%%j"
        set "varvalue=!varvalue:~!%%i=!"
        set "%%varname%%=!varvalue!"
    )
)

REM Check if Python is available
where python >nul 2>nul
if errorlevel 1 (
    echo Python not found. Please install Python.
    exit /b 1
)

python --version

REM Check if required Python packages are installed
if exist "requirements.txt" (
    for /f "tokens=1 delims==" %%i in (requirements.txt) do (
        set "package=%%i"
        if not "!package:~0,1!"=="#" (
            REM Try to import the module
            python -c "import !package!" 2>nul
            if errorlevel 1 (
                echo Package !package! is not available. Installing...
                python -m pip install !package!
            ) else (
                echo Package !package! is available
            )
        )
    )
) else (
    echo requirements.txt not found. Skipping package check.
)

REM Start funding process
python fund_wallets.py %1 %2

if errorlevel 1 (
    echo Funding process failed with exit code: %errorlevel%
    exit /b %errorlevel%
) else (
    echo Funding process completed successfully
)

REM Script completed
echo === Script completed ===