/** Shared wallet and journal completion tiers. No I/O or awards.
 * confirmed.casualCompletionCount is a hint for Shop checks, never proof of a grant.
 * No local count, raceCount, history length, or fabricated claim state is accepted.
 */
import {STYLE_COIN_MILESTONES} from './achievement-coin-schedule.mjs';
export {STYLE_COIN_MILESTONES};
const counter=value=>Number.isSafeInteger(value)&&value>=0&&value<=89?value:null;
export function buildStyleCoinAchievements(confirmed={}){
 const value=counter(Object.getOwnPropertyDescriptor(confirmed??{},'casualCompletionCount')?.value);
 return STYLE_COIN_MILESTONES.map(tier=>({id:'currency:'+tier.rewardId,laneId:'currency:recognized-tracks',laneTitle:'Ranked completion rewards',family:'currency',metric:'casualCompletionCount',source:'currency',
 target:tier.threshold,value,localValue:null,ratio:value===null?0:Math.min(1,value/tier.threshold),earned:false,eligible:value!==null&&value>=tier.threshold,
 goal:'Complete '+tier.threshold+' Ranked '+(tier.threshold===1?'track':'tracks'),
 description:'Finish different Ranked tracks. Sync your wallet in the Shop to collect eligible coins.',
 reward:Object.freeze({kind:'currency',currency:'Style Coins',amount:tier.amount,rewardId:tier.rewardId}),rewards:[],navigate:'shop'}));
}
export const isStyleCoinAchievement=item=>item?.source==='currency'&&STYLE_COIN_MILESTONES.some(tier=>tier.rewardId===item.reward?.rewardId&&tier.amount===item.reward?.amount&&tier.threshold===item.target);
