export function encodeBase64(bytes) {
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
  }
  return btoa(chunks.join(''));
}

export function decodeBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export async function blobDataUrl(blob) {
  return `data:${blob.type};base64,${encodeBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}
