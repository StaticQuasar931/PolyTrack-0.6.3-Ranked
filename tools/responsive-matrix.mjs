// Historical report shapes are coverage targets, not a device-popularity claim.
export const reportedSizes=[[1366,768],[1517,852],[1920,1080],[1536,864],[820,1180],[1300,730],[810,1080],[1280,720],[1280,800],[1440,900],[1600,1600],[1280,1200],[1241,697],[1470,956],[1200,750],[1536,960],[1600,900],[1187,667],[2560,1440],[800,600]];
export const portraitSizes=[[375,667],[375,812],[390,844],[393,852],[402,874],[440,956],[360,780],[384,832],[412,924],[414,896],[428,926],[430,932],[768,1024],[810,1080],[820,1180],[1024,1366]];
export const constrainedSizes=[[1366,600],[1366,650],[1280,600],[1280,650],[320,568],[844,320],[600,800]];
export const extendedSizes=[[3440,1440],[5120,1440],[3840,2160],[1920,1080],[1536,864],[384,216],[560,312],[600,400],[2800,1920]];
export const breakpointSizes=[599,600,601,699,700,701,999,1000,1001,1099,1100,1101].map(width=>[width,650]);
export const layoutMatrix=[...new Map([...reportedSizes,...portraitSizes,...portraitSizes.map(([w,h])=>[h,w]),...constrainedSizes,...extendedSizes,...breakpointSizes].map(([width,height])=>[width+'x'+height,{width,height,label:width+'x'+height}])).values()];
export const representativeSizes=[[1366,600],[1280,650],[390,844],[844,320],[820,1180],[1920,1080],[3440,1440]];
