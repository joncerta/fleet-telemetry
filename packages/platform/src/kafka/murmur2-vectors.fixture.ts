/**
 * Vectores de murmur2 de Apache Kafka (Java): `UtilsTest.testMurmur2`, en
 * clients/src/test/java/org/apache/kafka/common/utils/UtilsTest.java (rama trunk, copiados del archivo el 2026-10-04).
 * El valor es el `int` con signo que devuelve `Utils.murmur2(key.getBytes())`.
 */
export const KAFKA_MURMUR2_VECTORS: readonly { readonly key: string; readonly hash: number }[] = [
  { key: "21", hash: -973932308 },
  { key: "foobar", hash: -790332482 },
  { key: "a-little-bit-long-string", hash: -985981536 },
  { key: "a-little-bit-longer-string", hash: -1486304829 },
  { key: "lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8", hash: -58897971 },
  { key: "abc", hash: 479470107 },
];

/** Partición que elige el productor Java con key: `Utils.toPositive(murmur2(key)) % numPartitions`, con `toPositive = n & 0x7fffffff`. */
export const javaPartition = (hash: number, numPartitions: number): number => (hash & 0x7fffffff) % numPartitions;
