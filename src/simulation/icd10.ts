export const icd10Library = {
  diabetes: ['E11.9', 'E11.65', 'E11.22', 'E11.40', 'E10.9', 'E11.21', 'E11.42'],
  hypertension: ['I10', 'I11.9', 'I12.9', 'I16.0', 'I13.10'],
  behavioral: ['F32.9', 'F41.1', 'F43.23', 'F33.1', 'F43.9', 'F51.02'],
  cardiovascular: ['I25.10', 'I50.9', 'E78.5', 'I48.91'],
  pulmonary: ['J44.9', 'J45.909', 'J20.9'],
  renal: ['N18.2', 'N18.3', 'N18.9'],
  musculoskeletal: ['M54.50', 'M25.561', 'M79.10'],
  symptoms: ['R53.83', 'R07.9', 'R42', 'R51.9', 'R10.9', 'R06.02', 'R53.1', 'R11.0'],
  routine: ['Z00.00', 'Z79.4', 'Z79.899', 'Z13.6', 'Z71.89', 'Z12.11', 'Z13.1']
};

export const diseaseRegistry = [
  { key: 'diabetes', label: 'Type 2 diabetes', representativeIcd10: ['E11.9', 'E11.65', 'E11.22'] },
  { key: 'hypertension', label: 'Hypertension', representativeIcd10: ['I10', 'I11.9', 'I13.10'] },
  { key: 'heart_failure', label: 'Heart failure', representativeIcd10: ['I50.9'] },
  { key: 'coronary_disease', label: 'Coronary artery disease', representativeIcd10: ['I25.10'] },
  { key: 'hyperlipidemia', label: 'Hyperlipidemia', representativeIcd10: ['E78.5'] },
  { key: 'chronic_kidney_disease', label: 'Chronic kidney disease', representativeIcd10: ['N18.2', 'N18.3', 'N18.9'] },
  { key: 'copd_asthma', label: 'COPD or asthma', representativeIcd10: ['J44.9', 'J45.909'] },
  { key: 'depression_anxiety', label: 'Depression/anxiety', representativeIcd10: ['F32.9', 'F41.1', 'F33.1'] }
];

export const signalKeywords = {
  uncategorizedUtilization: ['nonspecific symptom', 'uncertain diagnosis cluster'],
  refillGap: ['refill delay', 'medication gap'],
  portalSpike: ['portal message spike'],
  severeCare: ['ER utilization', 'hospital admission']
};
