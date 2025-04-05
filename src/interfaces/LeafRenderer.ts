export type LeafRenderer = {
	setData: Function;
	originalSetData?: Function;
	nodes: Array<{
		getFillColor: () => { a: number; rgb: number };
		originalGetFillColor?: () => { a: number; rgb: number };
		type: string;
	}>;
	changed: () => void;
};
