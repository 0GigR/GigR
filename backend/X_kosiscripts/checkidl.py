import json
with open("app/services/gigr_program.json") as f:
    idl = json.load(f)
print(idl.keys())
print(idl.get("instructions")[0]["name"] if idl.get("instructions") else "NO INSTRUCTIONS")