import subprocess
from pathlib import Path
import sys

def run_script(script_name):
    print(f"\n>>> Running {script_name}...")
    result = subprocess.run([sys.executable, f"scripts/{script_name}"], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error in {script_name}:")
        print(result.stderr)
        return False
    print(result.stdout)
    return True

def main():
    scripts = [
        "load_transactions.py",
        "fetch_market_data.py",
        "calc_portfolio.py",
        "recommendations.py"
    ]
    
    for script in scripts:
        if not run_script(script):
            print("Pipeline failed.")
            sys.exit(1)
            
    print("\n>>> Pipeline completed successfully!")

if __name__ == "__main__":
    main()
