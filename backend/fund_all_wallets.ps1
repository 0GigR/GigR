# PowerShell script to fund all user wallets in the database
# Usage: .
#   fund_all_wallets.ps1 [amount] [token_type]
#   amount: Amount to fund each wallet (default: 1.0)
#   token_type: "sol" for SOL, "usdc" for USDC (default: sol)

param(
    [double]$Amount = 1.0,
    [string]$TokenType = "sol"
)

# Set error action preference
$ErrorActionPreference = "Stop"

# Load environment variables from .env file if it exists
if (Test-Path "..\.env") {
    Get-Content "..\.env" | ForEach-Object {
        if ($_ -match "^([^=]+)=(.*)$") {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            Set-ItemEnvironmentVariable -Name $name -Value $value -Scope Process
        }
    }
}

# Import required modules
Import-Module -Name "Microsoft.PowerShell.Utility"

# Function to log messages
function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] $Message"
}

# Function to check if Python is available
function Test-PythonEnvironment {
    try {
        $python = Get-Command python -ErrorAction Stop
        $version = & python --version
        Write-Log "Python found: $version"
        return $true
    }
    catch {
        Write-Log "Python not found. Please install Python."
        return $false
    }
}

# Function to check if required Python packages are installed
function Test-PythonPackages {
    try {
        $requirements = Get-Content "requirements.txt" -ErrorAction SilentlyContinue
        if (-not $requirements) {
            Write-Log "requirements.txt not found. Skipping package check."
            return $true
        }
        
        foreach ($line in $requirements) {
            $package = $line.Trim()
            if ($package -and -not $package.StartsWith("#")) {
                try {
                    $moduleName = $package.Split("/") | Select-Object -First 1
                    $moduleName = $moduleName.Split("[") | Select-Object -First 1
                    $moduleName = $moduleName.Trim()
                    
                    # Try to import the module
                    $null = Import-Module -Name $moduleName -ErrorAction Stop
                    Write-Log "Package $package is available"
                }
                catch {
                    Write-Log "Package $package is not available. Installing..."
                    & python -m pip install $package
                }
            }
        }
        return $true
    }
    catch {
        Write-Log "Error checking Python packages: $_"
        return $false
    }
}

# Function to run the funding script
function Start-FundingProcess {
    param(
        [double]$Amount,
        [string]$TokenType
    )
    
    try {
        Write-Log "Starting wallet funding process..."
        Write-Log "Amount: $Amount $TokenType"
        Write-Log "Token type: $TokenType"
        
        # Change to script directory
        $scriptDir = Split-Path -Path $MyInvocation.MyCommand.Path -Parent
        Set-Location -Path $scriptDir
        
        # Run the Python funding script
        $pythonArgs = @(
            "fund_wallets.py",
            "$Amount",
            "$TokenType"
        )
        
        Write-Log "Running Python script: python $($pythonArgs -join ' ')"
        $process = Start-Process -FilePath "python" -ArgumentList $pythonArgs -Wait -PassThru -NoNewWindow
        
        if ($process.ExitCode -eq 0) {
            Write-Log "Funding process completed successfully"
        }
        else {
            Write-Log "Funding process failed with exit code: $($process.ExitCode)"
            exit $process.ExitCode
        }
    }
    catch {
        Write-Log "Error running funding process: $_"
        exit 1
    }
}

# Main execution
Write-Log "=== Wallet Funding Script ==="

# Check Python environment
if (-not (Test-PythonEnvironment)) {
    exit 1
}

# Check Python packages
if (-not (Test-PythonPackages)) {
    Write-Log "Warning: Some packages may be missing. Continuing anyway..."
}

# Start funding process
Start-FundingProcess -Amount $Amount -TokenType $TokenType

Write-Log "=== Script completed ==="