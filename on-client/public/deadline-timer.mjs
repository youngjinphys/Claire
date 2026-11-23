// The owner supplies a positive finite remainder or throws its terminal cause.
// Start with an already sampled remainder; only wake-ups read remaining().
// Release the exact fired token before sampling; disposal prevents rearming.
export function ownedDeadlineTimer(remaining,fail){
  let timer,disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;const owned=timer;timer=undefined;if(owned!==undefined)clearTimeout(owned);};
  const arm=delay=>{
    if(disposed)return;
    const owned=setTimeout(()=>{
      if(disposed||timer!==owned)return;timer=undefined;clearTimeout(owned);if(disposed)return;
      let next;try{next=remaining();}catch(error){if(!disposed){dispose();fail(error);}return;}
      if(!disposed)arm(next);
    },Math.max(1,Math.ceil(delay)));
    if(disposed)clearTimeout(owned);else timer=owned;
  };
  return {arm,dispose};
}
