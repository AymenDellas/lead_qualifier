import Image from 'next/image';
import logo from '../../../public/brand/compel-logo.png';

export function CompelLogo() {
    return <span className="compel-logo"><Image src={logo} alt="Compel" sizes="200px" /></span>;
}
