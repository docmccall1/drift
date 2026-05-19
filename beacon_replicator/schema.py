LINE_KEY_COLS = ["claim_id", "line_id"]
LINE_REQUIRED = [
    "claim_id",
    "line_id",
    "patient_id",
    "provider_npi",
    "dos",
    "cpt",
    "units",
    "charge",
    "place_of_service",
]
LINE_OPTIONAL = ["modifiers", "icd10"]

LABEL_REQUIRED = ["claim_id", "line_id", "flagged"]
LABEL_OPTIONAL = ["reason"]

MULTI_VALUE_SEP = ";"
