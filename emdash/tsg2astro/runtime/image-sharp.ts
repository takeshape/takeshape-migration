/**
 * The image endpoint's transforms on Node (src/image-endpoint-node.ts), with sharp 0.35.5. It follows the plan
 * from imgix.ts with the geometry of Cloudflare's fit modes (`layout`), so a Node build and a Workers build make
 * images of the same size and crop. Face and saliency crops use sharp's attention and entropy strategies, which
 * pick their own spot. Animated images keep their first frame.
 */
import sharp from "sharp";
import { focalGravity, layout } from "./imgix.ts";
import type { ImagePlan } from "./imgix.ts";

export async function sharpTransform(bytes: Uint8Array<ArrayBuffer>, plan: ImagePlan): Promise<{ body: Uint8Array<ArrayBuffer>; type: string }> {
	const { autoOrient } = await sharp(bytes).metadata();
	const gravity = focalGravity(plan, autoOrient);
	const box = layout({ ...plan, gravity, focal: undefined }, autoOrient);

	let image = sharp(bytes, { autoOrient: true });
	if (plan.flip === "h" || plan.flip === "hv") image = image.flop();
	if (plan.flip === "v" || plan.flip === "hv") image = image.flip();
	if (box.crop && box.crop.left === undefined) {
		// sharp scales to cover the crop and picks the spot itself
		const position = gravity === "entropy" ? sharp.strategy.entropy : sharp.strategy.attention;
		image = image.resize(box.crop.width, box.crop.height, { fit: "cover", position });
	} else {
		image = image.resize(box.resize.width, box.resize.height, { fit: "fill" });
		if (box.crop) image = image.extract({ left: box.crop.left!, top: box.crop.top!, width: box.crop.width, height: box.crop.height });
	}
	if (box.pad) image = image.extend({ ...box.pad, background: plan.padColor ?? "#ffffff" });
	// bg fills the image's transparent pixels, padded or not. JPEG has no transparency, so there they take white
	// unless bg is set. The padding is opaque whenever bg is set (padColor falls back to it), so flattening can't
	// change its color.
	if (plan.background || plan.format === "jpeg") image = image.flatten({ background: plan.background ?? "#ffffff" });
	image = image.toFormat(plan.format, plan.quality === undefined ? {} : { quality: plan.quality });
	return { body: new Uint8Array(await image.toBuffer()), type: `image/${plan.format}` };
}
