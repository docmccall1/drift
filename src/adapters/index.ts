import { config } from '../config';
import { SimulationAdapter } from './simulationAdapter';
import { FhirR4FetcherStub } from './live/fhirFetcherStub';
import { EcwVendorAdapterStub } from './live/ecwVendorAdapter';
import { ClinicalDataAdapter } from './types';

let adapter: ClinicalDataAdapter | null = null;

export const getClinicalAdapter = (): ClinicalDataAdapter => {
  if (adapter) {
    return adapter;
  }

  if (config.adapterMode === 'simulation') {
    adapter = new SimulationAdapter();
    return adapter;
  }

  adapter = config.liveConnectorType === 'fhir' ? new FhirR4FetcherStub() : new EcwVendorAdapterStub();
  return adapter;
};

export const setClinicalAdapterForTesting = (value: ClinicalDataAdapter): void => {
  adapter = value;
};
