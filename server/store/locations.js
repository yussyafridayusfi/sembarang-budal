let savedLocations = [];

export function setLocations(locations) {
  savedLocations = locations;
}

export function getLocations() {
  return savedLocations;
}
