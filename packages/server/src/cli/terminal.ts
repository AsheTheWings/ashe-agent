/**
 * Reads one line from standard input. On a terminal it prints `prompt` to
 * standard error and turns echo off while the line is typed; otherwise it
 * reads the first line of the input.
 */
export const readSecretLine = async (prompt: string): Promise<string> => {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const text = await new Response(Bun.stdin.stream()).text()
    return text.split(/\r?\n/, 1)[0] ?? ""
  }
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  return await new Promise<string>((resolve, reject) => {
    let line = ""
    const finish = (result: string | Error) => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write("\n")
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(line)
        if (char === "\u0003") return finish(new Error("interrupted"))
        if (char === "\u007f" || char === "\b") line = line.slice(0, -1)
        else line += char
      }
    }
    stdin.on("data", onData)
  })
}
