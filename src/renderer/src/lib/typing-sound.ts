/** 打字音效：点击声用带通噪声 + 低频敲击合成，错误声用下滑锯齿波 */

let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null

function audio(): AudioContext | null {
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    try {
      ctx = new Ctor()
    } catch {
      return null
    }
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (noise) return noise
  const len = Math.floor(ac.sampleRate * 0.08)
  const buf = ac.createBuffer(1, len, ac.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1
  noise = buf
  return buf
}

export function playKey(): void {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime

  const src = ac.createBufferSource()
  src.buffer = noiseBuffer(ac)
  const band = ac.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 1_700 + Math.random() * 700
  band.Q.value = 1.2
  const click = ac.createGain()
  click.gain.setValueAtTime(0.0001, t)
  click.gain.exponentialRampToValueAtTime(0.14, t + 0.004)
  click.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
  src.connect(band).connect(click).connect(ac.destination)
  src.start(t)
  src.stop(t + 0.07)

  const thump = ac.createOscillator()
  thump.type = 'triangle'
  thump.frequency.setValueAtTime(170, t)
  thump.frequency.exponentialRampToValueAtTime(85, t + 0.05)
  const body = ac.createGain()
  body.gain.setValueAtTime(0.06, t)
  body.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
  thump.connect(body).connect(ac.destination)
  thump.start(t)
  thump.stop(t + 0.07)
}

export function playError(): void {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime

  const osc = ac.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(240, t)
  osc.frequency.exponentialRampToValueAtTime(110, t + 0.18)
  const filter = ac.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 900
  const gain = ac.createGain()
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
  osc.connect(filter).connect(gain).connect(ac.destination)
  osc.start(t)
  osc.stop(t + 0.24)

  const wobble = ac.createOscillator()
  wobble.type = 'square'
  wobble.frequency.setValueAtTime(120, t)
  wobble.frequency.linearRampToValueAtTime(90, t + 0.18)
  const wobbleGain = ac.createGain()
  wobbleGain.gain.setValueAtTime(0.05, t)
  wobbleGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
  wobble.connect(filter).connect(wobbleGain).connect(ac.destination)
  wobble.start(t)
  wobble.stop(t + 0.21)
}
