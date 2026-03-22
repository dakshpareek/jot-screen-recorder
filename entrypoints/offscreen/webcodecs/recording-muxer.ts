export interface RecordingMuxer {
  addVideoChunk(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void;
  addAudioChunk(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata): void;
  finalize(): ArrayBuffer | null;
}
