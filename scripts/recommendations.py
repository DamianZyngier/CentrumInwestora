import json
import yaml
from pathlib import Path

def load_config(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

def generate_recommendations(output_dir: Path, reference_dir: Path):
    print("Generating recommendations...")
    targets = load_config(reference_dir / "asset_classes.yaml")["targets"]
    
    # Load current asset structure
    asset_struct_path = output_dir / "portfolio_structure_asset_class.json"
    if not asset_struct_path.exists():
        print("Portfolio structure data not found. Run calc_portfolio.py first.")
        return
    
    with open(asset_struct_path, "r", encoding="utf-8") as f:
        current_weights = json.load(f)

    # Load portfolio list for concentration check
    with open(output_dir / "portfolio_list.json", "r", encoding="utf-8") as f:
        portfolio_list = json.load(f)

    recommendations = []
    
    # 1. Asset Class Deviation
    for asset_class, target in targets.items():
        current = current_weights.get(asset_class, 0.0)
        diff = current - target
        
        if diff < -0.05:
            recommendations.append({
                "type": "NIEDOWAGA",
                "category": asset_class,
                "current": f"{current:.1%}",
                "target": f"{target:.1%}",
                "message": f"Kategoria '{asset_class}' jest niedoważona. Rozważ dokupienie aktywów z tej grupy."
            })
        elif diff > 0.05:
            recommendations.append({
                "type": "PRZEWAGA",
                "category": asset_class,
                "current": f"{current:.1%}",
                "target": f"{target:.1%}",
                "message": f"Kategoria '{asset_class}' jest przeważona. Możesz rozważyć częściową realizację zysków."
            })

    # 2. Individual Asset Concentration
    for item in portfolio_list:
        if item["weight"] > 0.20:
            recommendations.append({
                "type": "KONCENTRACJA",
                "category": item["walor"],
                "current": f"{item['weight']:.1%}",
                "target": "<20%",
                "message": f"Walor '{item['walor']}' stanowi dużą część portfela. Ryzyko nadmiernej koncentracji."
            })

    result = {
        "summary": f"Wygenerowano {len(recommendations)} rekomendacji dotyczących struktury portfela.",
        "items": recommendations
    }

    with open(output_dir / "recommendations.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    
    print("Recommendations generated and saved.")

if __name__ == "__main__":
    BASE_DIR = Path(__file__).resolve().parent.parent
    generate_recommendations(
        output_dir=BASE_DIR / "data" / "output",
        reference_dir=BASE_DIR / "data" / "reference"
    )
