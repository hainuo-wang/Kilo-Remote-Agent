export class RemoteTextDecoder {
  private readonly decoder = new TextDecoder("utf-8")

  decode(chunk: Uint8Array): string {
    return this.decoder.decode(chunk, { stream: true })
  }

  end(): string {
    return this.decoder.decode()
  }
}
