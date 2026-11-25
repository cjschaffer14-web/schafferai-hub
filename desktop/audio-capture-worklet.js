// Runs only after an explicit Microphone click. Its output is silent: there is no
// local microphone monitor. Fractional area averaging downsamples to 16 kHz.
class SchafferMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();this.ratio=sampleRate/16000;this.remaining=this.ratio;this.sum=0;this.buffer=new ArrayBuffer(6400);this.view=new DataView(this.buffer);this.index=0;
  }
  process(inputs,outputs) {
    for(const channel of outputs[0]||[])channel.fill(0);
    const channels=inputs[0];if(!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++) {
      let value=0;for(const channel of channels)value+=channel[i]||0;value/=channels.length;
      let weight=1;
      while(weight>1e-8) {
        const taken=Math.min(weight,this.remaining);this.sum+=value*taken;this.remaining-=taken;weight-=taken;
        if(this.remaining<1e-8) {
          const sample=Math.max(-1,Math.min(1,this.sum/this.ratio));this.view.setInt16(this.index++*2,Math.round(sample<0?sample*32768:sample*32767),true);
          this.remaining=this.ratio;this.sum=0;
          if(this.index===3200){this.port.postMessage(this.buffer,[this.buffer]);this.buffer=new ArrayBuffer(6400);this.view=new DataView(this.buffer);this.index=0;}
        }
      }
    }
    return true;
  }
}
registerProcessor('schaffer-microphone',SchafferMicrophone);
