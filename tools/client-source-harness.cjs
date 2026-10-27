const vm=require('node:vm');
// Keep extracted production functions wired to their real shared transport.
module.exports=function createClientSourceRunner(source){
  return function runClientSource(code,context,...options){
    if(code.includes('rankedFetch(')&&!code.includes('function rankedFetch(')){
      const helper=source.match(/  function rankedFetch\([\s\S]*?\r?\n  \}/);
      if(!helper)throw Error('Missing production Ranked transport');
      context.Headers=Headers;
      if(helper[0].includes('observedWorkerFetch(')){
        const observed=source.match(/  function observedWorkerFetch\([\s\S]*?\r?\n  \}/);
        if(!observed)throw Error('Missing production Worker observer');
        context.performance=performance;context.noteDeveloperEvent??=()=>{};
        vm.runInContext(observed[0],context);
      }
      vm.runInContext(helper[0],context);
    }
    return vm.runInContext(code,context,...options);
  };
};
