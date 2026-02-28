import { afterEach, beforeEach } from "vitest";

const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  process.stdout.write = () => true;
  process.stderr.write = () => true;
});

afterEach(() => {
  process.stdout.write = realStdoutWrite;
  process.stderr.write = realStderrWrite;
});
