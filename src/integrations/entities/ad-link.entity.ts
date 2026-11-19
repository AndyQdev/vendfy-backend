import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from 'src/common/entities/base.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { IntegrationProvider } from './integration-connection.entity';

/** Cómo se estableció el vínculo entre el anuncio y el producto. */
export enum AdLinkOrigin {
  /** El dueño lo eligió en el panel. Es la fuente de verdad. */
  MANUAL = 'manual',
  /** Vendfy creó la campaña y sabe de qué producto nació. */
  CAMPAIGN = 'campaign',
}

/**
 * Qué producto vende un anuncio.
 *
 * Existe porque adivinarlo desde el texto del anuncio no siempre alcanza: el
 * copy publicitario dice «Inebriante Eau de Parfum» y el catálogo tiene dos
 * productos con ese nombre. Se declara UNA vez por anuncio —diez segundos en
 * el panel— y a partir de ahí toda conversación que nazca de ese anuncio sabe
 * exactamente de qué se trata, sin volver a interpretar nada.
 *
 * La alternativa que se descartó fue pedirle al comerciante que escriba el
 * nombre exacto del producto dentro del anuncio. Se descartó porque el anuncio
 * se redacta en el Ads Manager, fuera de Vendfy, y una regla que depende de
 * que alguien recuerde cumplirla falla en silencio el día que no la cumple.
 */
@Entity({ name: 'ad_link' })
@Index(['store', 'provider', 'externalAdId'], { unique: true })
export class AdLinkEntity extends BaseEntity {
  @ManyToOne(() => StoreEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store: StoreEntity;

  @Column({ type: 'enum', enum: IntegrationProvider })
  provider: IntegrationProvider;

  /** Id del anuncio en la plataforma (`source_id` del referral en Meta). */
  @Column({ type: 'varchar', length: 128 })
  externalAdId: string;

  /** Nombre del anuncio, solo para reconocerlo en el panel. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  adName: string | null;

  /**
   * Productos que vende el anuncio, como ids de `store_product`.
   *
   * Es un arreglo y no una relación a propósito: un anuncio puede promocionar
   * dos o tres productos, el orden importa —el primero es el principal— y
   * nunca se consulta al revés en el camino caliente. Una tabla intermedia
   * sería más ceremonia de la que el caso justifica.
   *
   * Vacío es válido y significativo: el dueño revisó este anuncio y decidió
   * que no vende un producto puntual (un anuncio de marca). Se distingue de
   * «todavía nadie lo revisó», que es no tener fila.
   */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  storeProductIds: string[];

  @Column({ type: 'enum', enum: AdLinkOrigin, default: AdLinkOrigin.MANUAL })
  origin: AdLinkOrigin;
}
